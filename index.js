const Influx = require('influx');
const express = require('express');
const http = require('http');
const request = require('request-promise-native');
const uuid = require('uuid/v4');
const debug = require('debug')('index');

// you can use localhost here if the docker where you run influx is in the same
// host.
const INFLUX_HOST = process.env.AP_INFLUX_HOST ; //'10.22.1.152';

// you can use localhost here, if OpenFaaS is running in the same host.
const OPENFAAS_GATEWAY = process.env.AP_OPENFAAS_GATEWAY; // 'http://10.22.1.80:8080';

// don't use localhost here, as this is the url must be reachable by the queue-worker-
const CALLBACK_URL = process.env.AP_CALLBACK_URL;  //'http://10.9.100.111:3008/webhook';


if (!INFLUX_HOST || !OPENFAAS_GATEWAY || !CALLBACK_URL) {
    console.log("You must set this environment variables: AP_INFLUX_HOST, AP_OPENFAAS_GATEWAY, AP_CALLBACK_UR");
    process.exit(1);
} // if (!INFLUX_HOST || !OPENFAAS_GATEWAY || !CALLBACK_URL) ...

// timeout for receiving the pong, in my scenario they
const TIMEOUT = process.env.AP_TIMEOUT || 1000; // ms

// interval between pings
const INTERVAL = process.env.AP_INTERVAL || 60 * 1000; // 1m

// where to store the values we send to the function, to check when it cames back
const pings = new Map();

const NOT_LISTED = 'not-listed';
const TIMEDOUT = 'timedout';
const COMPLETED = 'completed';

// the database instance we will use here
const influx = new Influx.InfluxDB({
    host: INFLUX_HOST,
    database: 'async_ping',
    schema: [
        {
            measurement: 'roundtrips',
            fields: {
                duration: Influx.FieldType.INTEGER
            },
            tags: ['status']
        }
    ] // schema ...
}); // influx ...

const app = express();

// what to do when we receive a pong
const saveReceived = id => new Promise((resolve, reject) => {
    const point = { measurement: 'roundtrips' };
    debug(`saveReceived | ${id}`);

    // try to delete the id from the list
    if (pings.has(id)) {
        debug(`saveReceived | ${id} completed`);

        const item = pings.get(id);

        // clear the timeout timer
        // IMPROVEMENT: save the timer id with the ping id, so we clear the
        // timeout only if we get the corresponding id that setted it.
        if (item.t) {
            debug(`saveReceived | clearing timeout`);
            clearTimeout(item.t);
        }

        pings.delete(id);
        debug(`saveReceived | ${id} removed`);

        point.tags = { status: COMPLETED };
        point.fields = { duration: Date.now() - item.start };
    } // if (!ping.has(id))  ...
    else {  // we received a not listed id, maybe a timedout one?
        debug(`saveReceived | ${id} not listed`);
        point.tags = { status: NOT_LISTED };
        point.fields = { duration: 0 };
    }

    // save it to the database
    influx
    .writePoints([point])
    .then(() => {
        debug(`saveReceived | ${id} saved`);
        resolve(true);
    })
    .catch(e => {
        debug(`saveReceived | ${id} error => ${e}`);
        reject(`saveReceived > ${e}`);
    });
}); // saveReceived ...

// the endpoint we expose to receive the callback
app.post('/webhook', (req, res) => {
    // debug("webhook headers =>", req.headers);

    // payload received at body
    if (req.body) {
        const received = req.body;
        debug('webhook | body =>', received);
        saveReceived(received)
            .then(() => res.status(200).end())
            .catch(e => res.status(500).end());
    }
    // payload received as stream (usually when queue-worker is calling)
    else {
        let received = '';

        req.on('data', data => {
            // debug('webhook | data');
            received += data.toString();
        });

        req.on('end', () => {
            debug('<< webhook | received =>', received);
            saveReceived(received)
                .then(() => res.status(200).end())
                .catch(e => res.status(500).end(e.message));
        });

        req.on('error', error => {
            // debug('on/error');
            console.error('webhook | error =>', error);
        });
    }
}); // webhook ...

// let's create the express server
let server = http.createServer(app);

// Initialize the database, create if not exists, listen the express server if successful
influx
    .getDatabaseNames()
    .then(names => {    // check if database exists, create if not
        debug(`database names => ${JSON.stringify(names, null, 2)}`);
        if (!names.includes('async_ping')) {
            debug('create database');
            return influx.createDatabase('async_ping');
        }
    })
    .then(() => {   // create successful, listen for callbacks
        debug('create server');
        server.listen(3008, () => console.log(`Listening on ${server.address().port}`) );
    })
    .catch(e => console.log(`Error creating Influx Database!`));

// If we dont get a pong in certain amount of time
const timedOut = id => () => {
    debug(`timedOut | ${id} expired`);

    let elapsed = 0;

    // remove the id from our list
    if (pings.has(id)) {
        const item = pings.get(id);
        pings.delete(id);
        debug(`timedOut | ${id} removed`);

        elapsed = Date.now() - item.start;
    } // if (pings.has(id)) ...

    // save it to the database
    influx.writePoints([{
        measurement: 'roundtrips',
        tags: { status: TIMEDOUT },
        fields: { duration: elapsed }
    }]);
}; // timedOut ...

const generatePing = () => new Promise((resolve, reject) => {
    try {
        // the payload for our ping
        const id = uuid();
        debug(`*****************************************************************`);
        debug(`   ${id}`);
        debug(`*****************************************************************`);

        // save the id to check it later
        pings.set(id, {
            start: Date.now(),
            t: setTimeout(timedOut(id), TIMEOUT)
        });

        resolve(id)
    }
    catch(e) { reject(`generatePing > ${e}`); }
    ;
});

// the ping loop
setInterval(async () => {
    try {
        const id = await generatePing();
        const result = await request({
            method: 'POST',
            headers: { 'X-Callback-Url': CALLBACK_URL },
            uri: `${OPENFAAS_GATEWAY}/async-function/echoit`,
            body: id,
            proxy: null,
            resolveWithFullResponse: true
        });

    }
    catch(e) {
        debug(`timer | ${id} error => ${e}`);
        const p = pings.get(id);
        if (p) clearTimeout(p.t);
    }
}, INTERVAL);

/*=============================================================================
    Manejadores para tener una salida limpia
=============================================================================*/
process.stdin.resume(); //so the program will not close instantly

function exitHandler({ cleanup = false, exit = true }, exitCode) {
    if (cleanup) {
        // if (model && model instanceof Object) {
        //   model.cleanup();
        // }
        // influx.close();
        console.log('Clean exit');
    }

    if (exitCode || exitCode === 0) {
        console.log('Exit code:', exitCode);
    }

    if (exit) process.exit();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { cleanup: true }));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null));
process.on('SIGUSR2', exitHandler.bind(null));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null));
