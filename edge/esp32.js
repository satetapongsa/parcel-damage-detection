// Link to the ESP32/PLC controller. JSON-lines protocol, one object per line.
//   transport "serial": USB-UART (real hardware), e.g. ESP32_PORT=COM5 or /dev/ttyUSB0
//   transport "mqtt"  : ESP32 over WiFi, or the simulator
const { EventEmitter } = require('node:events');
const { TOPICS, log } = require('../shared/common');

class Esp32Link extends EventEmitter {
  constructor({ transport, port, baud, localMqtt }) {
    super();
    this.transport = transport;
    this.connected = false;
    this.lastSeen = 0;
    if (transport === 'serial') this._openSerial(port, baud);
    else this._openMqtt(localMqtt);
    setInterval(() => {
      const alive = Date.now() - this.lastSeen < 6000;
      if (alive !== this.connected) { this.connected = alive; this.emit('link', alive); }
    }, 1000);
  }

  _handle(line) {
    let msg;
    try { msg = typeof line === 'string' ? JSON.parse(line) : line; } catch { return; }
    if (!msg || !msg.evt) return;
    this.lastSeen = Date.now();
    this.emit('evt', msg);
  }

  _openSerial(path, baudRate) {
    let SerialPort, ReadlineParser;
    try {
      ({ SerialPort } = require('serialport'));
      ({ ReadlineParser } = require('@serialport/parser-readline'));
    } catch (e) {
      log('esp32', 'serialport module not available:', e.message);
      return;
    }
    const open = () => {
      const sp = new SerialPort({ path, baudRate, autoOpen: false });
      sp.open((err) => {
        if (err) { log('esp32', `open ${path} failed: ${err.message} (retry in 3s)`); return setTimeout(open, 3000); }
        log('esp32', `serial ${path} @${baudRate} opened`);
        this.port = sp;
        sp.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (l) => this._handle(l.trim()));
        sp.on('close', () => { log('esp32', 'serial closed, reopening'); this.port = null; setTimeout(open, 2000); });
        sp.on('error', (e) => log('esp32', 'serial error', e.message));
      });
    };
    open();
  }

  _openMqtt(client) {
    this.mqtt = client;
    client.subscribe(TOPICS.esp32Evt, { qos: 1 });
    client.on('message', (topic, buf) => { if (topic === TOPICS.esp32Evt) this._handle(buf.toString()); });
    log('esp32', 'using MQTT transport on', TOPICS.esp32Evt);
  }

  send(cmd) {
    const line = JSON.stringify(cmd);
    if (this.transport === 'serial') { if (this.port) this.port.write(line + '\n'); }
    else if (this.mqtt) this.mqtt.publish(TOPICS.esp32Cmd, line, { qos: 1 });
  }
}

module.exports = { Esp32Link };
