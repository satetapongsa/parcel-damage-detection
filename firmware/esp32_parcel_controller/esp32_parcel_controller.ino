/*
 * ESP32 Parcel Controller — IR trigger, load cell, pusher servo, tower light, buzzer, belt relay.
 * Talks to the Edge Gateway over USB-UART, JSON lines @115200.
 *
 *  ESP32 -> Gateway : {"evt":"hello"} {"evt":"trigger","seq":1} {"evt":"weight","seq":1,"g":512.3}
 *                     {"evt":"done","seq":1,"action":"reject","late":0} {"evt":"jam","ms":3100}
 *                     {"evt":"jam_clear"} {"evt":"failsafe","seq":1} {"evt":"hb"}
 *  Gateway -> ESP32 : {"cmd":"reject","seq":1} {"cmd":"pass","seq":1}
 *                     {"cmd":"config","delay_ms":1500,"hold_ms":400,"jam_ms":3000,"failsafe":"REJECT"}
 *                     {"cmd":"light","base":"yellow"|"off"} {"cmd":"belt","run":true}
 *
 * Timing is done HERE (not on the PC): the pusher fires exactly delay_ms after the IR trigger.
 * If the gateway never answers (PC crash, cable pulled) the firmware applies its own fail-safe.
 *
 * Libraries (Arduino Library Manager): ArduinoJson (v7), ESP32Servo, HX711 (by Bogdan Necula)
 */
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <HX711.h>

// ---------------- pins (change to match your wiring) ----------------
const int PIN_IR      = 32;  // IR breakbeam receiver (LOW = beam broken)
const int PIN_SERVO   = 13;  // pusher servo signal
const int PIN_GREEN   = 25;  // tower light green (via relay / MOSFET)
const int PIN_YELLOW  = 26;  // tower light yellow
const int PIN_RED     = 27;  // tower light red
const int PIN_BUZZER  = 14;  // buzzer
const int PIN_BELT    = 33;  // belt motor relay (HIGH = run)
const int PIN_HX_DT   = 16;  // HX711 data
const int PIN_HX_SCK  = 17;  // HX711 clock

const int SERVO_HOME = 0, SERVO_PUSH = 90;
const float HX_CALIBRATION = 420.0f;   // run a calibration sketch with a known weight and set this

// ---------------- tunable (overwritten by {"cmd":"config"}) ----------------
unsigned long delayMs = 1500, holdMs = 400, jamMs = 3000;
bool failsafeReject = true;

// ---------------- state ----------------
Servo pusher;
HX711 scale;
struct Parcel { uint32_t seq; unsigned long t0; int8_t decision; bool done; }; // decision: -1 none, 0 pass, 1 reject
const int QN = 16;
Parcel q[QN];
uint32_t seqCounter = 0;
bool baseYellow = true;            // yellow until the gateway says everything is fine
bool jammed = false;
bool beltRun = true;
unsigned long irLowSince = 0;
bool irPrev = true;
unsigned long greenUntil = 0, redUntil = 0, pushUntil = 0, lastHb = 0;
String rx;

void sendJson(JsonDocument &d) { serializeJson(d, Serial); Serial.println(); }
void evt(const char *e) { JsonDocument d; d["evt"] = e; sendJson(d); }

Parcel *findSeq(uint32_t s) {
  for (int i = 0; i < QN; i++) if (q[i].seq == s && !q[i].done) return &q[i];
  return nullptr;
}
Parcel *slot() {
  for (int i = 0; i < QN; i++) if (q[i].done || q[i].seq == 0) return &q[i];
  return &q[0];
}

void fireReject(uint32_t seq, long late) {
  pusher.write(SERVO_PUSH);
  pushUntil = millis() + holdMs;
  redUntil = millis() + 1500;
  JsonDocument d; d["evt"] = "done"; d["seq"] = seq; d["action"] = "reject"; d["late"] = late > 0 ? late : 0;
  sendJson(d);
}

void handleCmd(const String &line) {
  JsonDocument d;
  if (deserializeJson(d, line)) return;
  const char *cmd = d["cmd"] | "";
  if (!strcmp(cmd, "reject") || !strcmp(cmd, "pass")) {
    bool rej = !strcmp(cmd, "reject");
    if (d["seq"].isNull()) {                     // manual test / CiRA-only mode: act now (+delay)
      if (rej) { Parcel *p = slot(); p->seq = 0xFFFFFFFF; p->t0 = millis(); p->decision = 1; p->done = false; }
      else greenUntil = millis() + 1000;
      return;
    }
    Parcel *p = findSeq(d["seq"].as<uint32_t>());
    if (!p) return;
    p->decision = rej ? 1 : 0;
    if (!rej) { greenUntil = millis() + 1000; p->done = true; }
  } else if (!strcmp(cmd, "config")) {
    delayMs = d["delay_ms"] | delayMs;
    holdMs = d["hold_ms"] | holdMs;
    jamMs = d["jam_ms"] | jamMs;
    failsafeReject = strcmp(d["failsafe"] | "REJECT", "PASS") != 0;
  } else if (!strcmp(cmd, "light")) {
    baseYellow = !strcmp(d["base"] | "off", "yellow");
  } else if (!strcmp(cmd, "belt")) {
    beltRun = d["run"] | true;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_IR, INPUT_PULLUP);
  for (int p : {PIN_GREEN, PIN_YELLOW, PIN_RED, PIN_BUZZER, PIN_BELT}) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  pusher.attach(PIN_SERVO);
  pusher.write(SERVO_HOME);
  scale.begin(PIN_HX_DT, PIN_HX_SCK);
  scale.set_scale(HX_CALIBRATION);
  scale.tare();
  for (int i = 0; i < QN; i++) q[i] = {0, 0, -1, true};
  evt("hello");
}

void loop() {
  unsigned long now = millis();

  // ---- serial commands ----
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleCmd(rx); rx = ""; }
    else if (c != '\r' && rx.length() < 512) rx += c;
  }

  // ---- IR breakbeam: falling edge = new parcel, held low = jam ----
  bool ir = digitalRead(PIN_IR);      // HIGH = clear
  if (irPrev && !ir && !jammed) {
    Parcel *p = slot();
    *p = {++seqCounter, now, -1, false};
    JsonDocument d; d["evt"] = "trigger"; d["seq"] = p->seq; sendJson(d);
    delay(150);                        // let the parcel settle on the load cell
    if (scale.is_ready()) {
      JsonDocument w; w["evt"] = "weight"; w["seq"] = p->seq; w["g"] = scale.get_units(5); sendJson(w);
    }
    irLowSince = now;
  }
  if (!ir && irLowSince && !jammed && now - irLowSince > jamMs) {
    jammed = true; beltRun = false;
    JsonDocument d; d["evt"] = "jam"; d["ms"] = now - irLowSince; sendJson(d);
  }
  if (ir) {
    if (jammed) { jammed = false; beltRun = true; evt("jam_clear"); }
    irLowSince = 0;
  }
  irPrev = ir;

  // ---- scheduled pushes + firmware fail-safe ----
  for (int i = 0; i < QN; i++) {
    Parcel &p = q[i];
    if (p.done || p.seq == 0) continue;
    unsigned long fireAt = p.t0 + delayMs;
    if (p.decision == 1 && now >= fireAt) { fireReject(p.seq, (long)(now - fireAt) > 50 ? now - fireAt : 0); p.done = true; }
    else if (p.decision == -1 && now + 30 >= fireAt) {   // gateway silent until the last moment
      JsonDocument d; d["evt"] = "failsafe"; d["seq"] = p.seq; sendJson(d);
      if (failsafeReject) fireReject(p.seq, 0); else greenUntil = now + 1000;
      p.done = true;
    }
  }
  if (pushUntil && now >= pushUntil) { pusher.write(SERVO_HOME); pushUntil = 0; }

  // ---- outputs ----
  bool red = now < redUntil || jammed;
  digitalWrite(PIN_RED, red ? (jammed ? (now / 300) % 2 : HIGH) : LOW);
  digitalWrite(PIN_BUZZER, now < redUntil ? (now / 150) % 2 : LOW);
  digitalWrite(PIN_GREEN, now < greenUntil ? HIGH : LOW);
  digitalWrite(PIN_YELLOW, baseYellow || jammed ? HIGH : LOW);
  digitalWrite(PIN_BELT, beltRun && !jammed ? HIGH : LOW);

  if (now - lastHb > 2000) { evt("hb"); lastHb = now; }
}
