/*
  ARGUS mount firmware — ESP32-S3 alt-az pointing head (pan = azimuth, tilt = elevation)

  Receives pointing commands from the ARGUS web console over USB (Web Serial) and,
  optionally, Wi-Fi (WebSocket on port 81, mDNS name argus-mount.local).

  Protocol — ASCII lines terminated by '\n':
    host -> mount   AZEL <az> <el> [azRate] [elRate]   degrees (az from true north, clockwise), deg/s
                    PARK | STOP | PING
    mount -> host   HELLO ARGUS-MOUNT <version>
                    POS <az> <el>                       actual pointing, 10 Hz
                    PONG | OK <cmd> | ERR <reason>

  Hardware (starter configuration): two 180° hobby servos on a pan/tilt bracket.
  "Flip" mapping lets 180° servos cover the full sky: azimuths 180–360° are reached by
  rotating pan to az−180° and tilting past the zenith (tilt = 180° − el).

  Built for Arduino-ESP32 core 3.x (also compiles on 2.x). Board: "ESP32S3 Dev Module",
  USB CDC On Boot: Enabled. Not yet tested on hardware — verify servo directions and
  pulse limits on the bench before mounting a camera.
*/
#include <Arduino.h>

// ───────────────────────── configuration ─────────────────────────
#define ENABLE_WIFI 0          // 1 = also listen on ws://argus-mount.local:81/ (needs the "WebSockets" library by Markus Sattler)
#define FW_VERSION "1.0"

const int   PAN_PIN = 4;       // azimuth servo signal
const int   TILT_PIN = 5;      // elevation servo signal
const int   SERVO_HZ = 50;
const int   PWM_BITS = 14;
const int   PAN_MIN_US = 500,  PAN_MAX_US = 2500;    // pulse widths at 0° and 180° — calibrate!
const int   TILT_MIN_US = 500, TILT_MAX_US = 2500;
const bool  PAN_INVERT = false;                      // set true if the head turns the wrong way
const bool  TILT_INVERT = false;
const float MAX_SLEW_DPS = 60.0f;                    // servo-space slew limit, deg/s
const float PARK_AZ = 0.0f, PARK_EL = 90.0f;
const uint32_t LINK_TIMEOUT_MS = 30000;              // park if no command for this long
const float MIN_EL = 0.0f, MAX_EL = 90.0f;

#if ENABLE_WIFI
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
const char* WIFI_SSID = "your-ssid";
const char* WIFI_PASS = "your-password";
WebSocketsServer ws(81);
#endif

// ───────────────────────── state ─────────────────────────
struct Command { float az, el, azRate, elRate; uint32_t at; };
Command cmd = {PARK_AZ, PARK_EL, 0, 0, 0};
float panPos = 0, tiltPos = 90;          // current servo angles (deg)
float curAz = PARK_AZ, curEl = PARK_EL;  // current pointing
uint32_t lastTelemetry = 0;
bool parkedForTimeout = false;
char lineBuf[128];
size_t lineLen = 0;

// ───────────────────────── servo output ─────────────────────────
static uint32_t usToDuty(float us) { return (uint32_t)(us * ((1 << PWM_BITS) - 1) / (1000000.0f / SERVO_HZ)); }

static void servoAttach(int pin, int channel) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)channel;
  ledcAttach(pin, SERVO_HZ, PWM_BITS);
#else
  ledcSetup(channel, SERVO_HZ, PWM_BITS);
  ledcAttachPin(pin, channel);
#endif
}
static void servoWrite(int pin, int channel, float angle, int minUs, int maxUs, bool invert) {
  angle = constrain(angle, 0.0f, 180.0f);
  if (invert) angle = 180.0f - angle;
  uint32_t duty = usToDuty(minUs + (maxUs - minUs) * angle / 180.0f);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)channel;
  ledcWrite(pin, duty);
#else
  (void)pin;
  ledcWrite(channel, duty);
#endif
}

// az/el <-> pan/tilt with the over-the-top flip.
static void azelToServo(float az, float el, float &pan, float &tilt) {
  az = fmodf(fmodf(az, 360.0f) + 360.0f, 360.0f);
  el = constrain(el, MIN_EL, MAX_EL);
  if (az <= 180.0f) { pan = az;          tilt = el; }
  else              { pan = az - 180.0f; tilt = 180.0f - el; }
}
static void servoToAzel(float pan, float tilt, float &az, float &el) {
  if (tilt <= 90.0f) { az = pan;          el = tilt; }
  else               { az = pan + 180.0f; el = 180.0f - tilt; }
}

// ───────────────────────── messaging ─────────────────────────
static void reply(const char *msg) {
  Serial.println(msg);
#if ENABLE_WIFI
  ws.broadcastTXT(msg);
#endif
}

static int parseFloats(const char *p, float *out, int maxN) {
  int n = 0;
  while (n < maxN) {
    char *end;
    float v = strtof(p, &end);
    if (end == p) break;
    out[n++] = v;
    p = end;
  }
  return n;
}

static void handleLine(char *s) {
  while (*s == ' ' || *s == '\t') s++;
  size_t len = strlen(s);
  while (len && (s[len - 1] == '\r' || s[len - 1] == ' ')) s[--len] = 0;
  if (!len) return;
  if (strncmp(s, "AZEL", 4) == 0) {
    float v[4] = {0, 0, 0, 0};
    int n = parseFloats(s + 4, v, 4);
    if (n < 2 || isnan(v[0]) || isnan(v[1])) { reply("ERR bad AZEL"); return; }
    cmd = {v[0], v[1], n > 2 ? v[2] : 0.0f, n > 3 ? v[3] : 0.0f, millis()};
    parkedForTimeout = false;
  } else if (strcmp(s, "PARK") == 0) {
    cmd = {PARK_AZ, PARK_EL, 0, 0, millis()};
    reply("OK PARK");
  } else if (strcmp(s, "STOP") == 0) {
    cmd = {curAz, curEl, 0, 0, millis()};
    reply("OK STOP");
  } else if (strcmp(s, "PING") == 0) {
    reply("PONG");
  } else {
    reply("ERR unknown command");
  }
}

static void feed(char c) {
  if (c == '\n') { lineBuf[lineLen] = 0; handleLine(lineBuf); lineLen = 0; }
  else if (lineLen < sizeof(lineBuf) - 1) lineBuf[lineLen++] = c;
  else lineLen = 0;  // overflow: drop the line
}

#if ENABLE_WIFI
static void onWs(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_CONNECTED) ws.sendTXT(num, "HELLO ARGUS-MOUNT " FW_VERSION " (wifi)");
  else if (type == WStype_TEXT) { for (size_t i = 0; i < length; i++) feed((char)payload[i]); feed('\n'); }
}
#endif

// ───────────────────────── setup / loop ─────────────────────────
void setup() {
  Serial.begin(115200);
  servoAttach(PAN_PIN, 0);
  servoAttach(TILT_PIN, 1);
  azelToServo(PARK_AZ, PARK_EL, panPos, tiltPos);
  servoWrite(PAN_PIN, 0, panPos, PAN_MIN_US, PAN_MAX_US, PAN_INVERT);
  servoWrite(TILT_PIN, 1, tiltPos, TILT_MIN_US, TILT_MAX_US, TILT_INVERT);
#if ENABLE_WIFI
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    MDNS.begin("argus-mount");
    ws.begin();
    ws.onEvent(onWs);
    Serial.printf("Wi-Fi %s  ws://%s:81/  ws://argus-mount.local:81/\n", WIFI_SSID, WiFi.localIP().toString().c_str());
  } else {
    Serial.println("Wi-Fi not connected — USB only");
  }
#endif
  reply("HELLO ARGUS-MOUNT " FW_VERSION);
}

void loop() {
  while (Serial.available()) feed((char)Serial.read());
#if ENABLE_WIFI
  ws.loop();
#endif

  static uint32_t lastUs = micros();
  uint32_t nowUs = micros();
  float dt = (nowUs - lastUs) / 1e6f;
  lastUs = nowUs;

  // Target = last command, extrapolated with the host's rates between packets (smooth tracking).
  float age = (millis() - cmd.at) / 1000.0f;
  float tAz = cmd.az, tEl = cmd.el;
  if (age < 2.0f) { tAz += cmd.azRate * age; tEl += cmd.elRate * age; }
  if (millis() - cmd.at > LINK_TIMEOUT_MS && !parkedForTimeout) {
    cmd = {PARK_AZ, PARK_EL, 0, 0, millis()};
    parkedForTimeout = true;
    reply("OK PARK (link timeout)");
  }

  float panT, tiltT;
  azelToServo(tAz, tEl, panT, tiltT);
  float step = MAX_SLEW_DPS * dt;
  panPos  += constrain(panT - panPos,  -step, step);
  tiltPos += constrain(tiltT - tiltPos, -step, step);
  servoWrite(PAN_PIN, 0, panPos, PAN_MIN_US, PAN_MAX_US, PAN_INVERT);
  servoWrite(TILT_PIN, 1, tiltPos, TILT_MIN_US, TILT_MAX_US, TILT_INVERT);
  servoToAzel(panPos, tiltPos, curAz, curEl);

  if (millis() - lastTelemetry >= 100) {
    lastTelemetry = millis();
    char buf[48];
    snprintf(buf, sizeof(buf), "POS %.2f %.2f", fmodf(curAz + 360.0f, 360.0f), curEl);
    reply(buf);
  }
  delay(5);
}
