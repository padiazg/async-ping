# OpenFaaS Async Ping

This project was created to track an issue that happens when NATS is respawned by the stack.

# InfluxDB  
Before run the project you need an InfluxDB instance, follow instructions from [influxdb.md](./influxdb.md).

# OpenFaaS
We will use the echoit funtion as our ping/pong mechanism. It is part of the demos hat comes with the stack, if you don't have it runnig already do this:
```bash
$ faas-cli deploy --name echoit --image functions/alpine:latest --fprocess cat
```

# Node.js
## Adust constants
On index.js, adjust the values for

* **INFLUX_HOST**: The host to reach the influxdb server, usually the docker container you just run.

* **OPENFAAS_GATEWAY**: The full URI where your OpenFaaS is. Ex: `http://localhost:8080`

* **CALLBACK_URL**: This is the endpoint this project exposes as callback for the async-call. You should avoid using localhost, and use your network IP instead. Ex: `http://10.9.100.111:3008/webhook`

## Run
```bash
$ npm install
$ export DEBUG=*,-express*
$ node .
```

# Grafana
To visualize the data I use a Grafana panel, the exported JSON is in [grafana-panel.json](./grafana-panel.json).
I set an alert that fires when there are 3 timedout measurement in a 5 min window, you can send that alert through whichever channel you like or have.

# Mess with the data
To query the database it must exist, pretty obviuos, so the node.js project must run at least once.

### Run the CLI
```bash
$ docker run --rm -it influxdb:alpine influx --host <your-docker-host>
```
### Query the measurements
```bash
> use async_ping;
> select * from roundtrips;
```
