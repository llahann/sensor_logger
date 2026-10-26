// Smartstake data logger — ESP32 Feather
// Reads ISE/RE pairs through two 8:1 analog muxes into an ADS1110 ADC,
// plus two DS18B20 temperature probes and the battery voltage.
// Output: one CSV row per cycle:
//   temp1, temp2, vbat, [stake 1 pairs], [stake 2 pairs]
// Each stake's pairs are ordered RE-major: (RE1: ISE1..3), (RE2: ISE1..3), ...
// Each row is also posted to a Google Sheet through an Apps Script web app
// (see google_apps_script/Code.gs). Upload status lines start with '#'.
// WiFi credentials, the web app URL and the shared token live in secrets.h.

#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "secrets.h"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const uint32_t SERIAL_BAUD     = 9600;
const uint32_t SETTLE_MS       = 3000;  // settling time after switching a pair
const uint32_t CYCLE_PAUSE_MS  = 1000;  // pause between CSV rows

// ADS1110 ADC
const uint8_t ADS1110_ADDR   = 0x48;
const uint8_t ADS1110_CONFIG = 0x0C;     // continuous, 15 SPS (16-bit), PGA x1
const float   ADS1110_VREF   = 2.048f;
const float   ADS1110_FULL_SCALE = 32768.0f;

// Temperature sensors and battery
const uint8_t ONE_WIRE_BUS_1 = 26;
const uint8_t ONE_WIRE_BUS_2 = 25;
const uint8_t VBAT_PIN       = 35;       // behind a 1:2 divider on the Feather V2
                                         // (ADC1, so it still works with WiFi on)

// Google Sheets upload
const uint32_t WIFI_TIMEOUT_MS = 15000;  // max wait for a (re)connect each cycle
const uint16_t HTTP_TIMEOUT_MS = 15000;
const uint8_t  WIFI_RESET_AFTER = 3;          // failed uploads in a row before a fresh WiFi connect
const uint32_t REBOOT_AFTER_MS  = 5UL * 60 * 1000;  // reboot if nothing uploaded for this long

// ---------------------------------------------------------------------------
// Multiplexers
// ---------------------------------------------------------------------------

struct Mux {
  uint8_t a, b, c, inh;       // select lines and active-LOW inhibit
  int     pcbChannel[8];      // index = mux hardware channel, value = PCB channel (1-8)
};

const Mux ISE_MUX = {14, 32, 15, 33, {2, 3, 4, 1, 5, 8, 6, 7}};
const Mux RE_MUX  = {27, 12, 21,  4, {3, 2, 1, 4, 5, 7, 6, 8}};

// Which PCB channels belong to each Smartstake
struct Stake {
  int firstRE, lastRE;
  int firstISE, lastISE;
};

const Stake STAKES[] = {
  {1, 2, 1, 3},   // Smartstake 1: RE 1-2, ISE 1-3
};
const size_t NUM_STAKES = sizeof(STAKES) / sizeof(STAKES[0]);

void muxInit(const Mux &m) {
  pinMode(m.a, OUTPUT);
  pinMode(m.b, OUTPUT);
  pinMode(m.c, OUTPUT);
  pinMode(m.inh, OUTPUT);
  digitalWrite(m.inh, HIGH);  // start disabled
}

void muxDisable(const Mux &m) {
  digitalWrite(m.inh, HIGH);
}

// Returns the mux hardware channel (0-7) for a PCB channel, or -1 if unmapped.
int muxHardwareChannel(const Mux &m, int pcbChannel) {
  for (int hw = 0; hw < 8; hw++) {
    if (m.pcbChannel[hw] == pcbChannel) return hw;
  }
  return -1;
}

// Connects the given PCB channel. Leaves the mux disabled if the channel is unmapped.
bool muxSelect(const Mux &m, int pcbChannel) {
  int hw = muxHardwareChannel(m, pcbChannel);

  // Disable while changing address so channels never briefly overlap
  muxDisable(m);
  if (hw < 0) return false;

  digitalWrite(m.a, (hw & 0x01) ? HIGH : LOW);
  digitalWrite(m.b, (hw & 0x02) ? HIGH : LOW);
  digitalWrite(m.c, (hw & 0x04) ? HIGH : LOW);
  delayMicroseconds(5);

  digitalWrite(m.inh, LOW);   // enable
  return true;
}

// ---------------------------------------------------------------------------
// ADC
// ---------------------------------------------------------------------------

void adcInit() {
  Wire.beginTransmission(ADS1110_ADDR);
  Wire.write(ADS1110_CONFIG);
  Wire.endTransmission();
}

// Returns the differential input voltage in volts, or NAN if the read failed.
float adcReadVolts() {
  if (Wire.requestFrom(ADS1110_ADDR, (uint8_t)3) < 2) return NAN;

  uint8_t hi = Wire.read();
  uint8_t lo = Wire.read();
  while (Wire.available()) Wire.read();   // discard config byte

  int16_t raw = (int16_t)((hi << 8) | lo);
  return raw * ADS1110_VREF / ADS1110_FULL_SCALE;
}

// Connects one ISE/RE pair, waits for it to settle, and returns the voltage.
float readPair(int iseChannel, int reChannel) {
  if (!muxSelect(ISE_MUX, iseChannel) || !muxSelect(RE_MUX, reChannel)) {
    return NAN;
  }
  delay(SETTLE_MS);
  return adcReadVolts();
}

// ---------------------------------------------------------------------------
// Temperature and battery
// ---------------------------------------------------------------------------

OneWire oneWire1(ONE_WIRE_BUS_1);
OneWire oneWire2(ONE_WIRE_BUS_2);
DallasTemperature temps1(&oneWire1);
DallasTemperature temps2(&oneWire2);

// Starts both conversions at once and waits a single conversion time.
void readTemperatures(float &t1, float &t2) {
  temps1.requestTemperatures();
  temps2.requestTemperatures();
  delay(temps1.millisToWaitForConversion(temps1.getResolution()));
  t1 = temps1.getTempCByIndex(0);   // -127 if the probe is disconnected
  t2 = temps2.getTempCByIndex(0);
}

float readBatteryVolts() {
  // analogReadMilliVolts uses the ESP32's factory ADC calibration
  return analogReadMilliVolts(VBAT_PIN) * 2.0f / 1000.0f;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

struct Column {
  String  name;
  uint8_t decimals;
};

const size_t MAX_COLUMNS = 3 + 8 * 8;   // temps, vbat, every possible pair
Column columns[MAX_COLUMNS];
size_t numColumns = 0;

void addColumn(const String &name, uint8_t decimals) {
  if (numColumns < MAX_COLUMNS) columns[numColumns++] = {name, decimals};
}

// Names every CSV field in the order loop() measures them, e.g. "s1_re2_ise3".
void buildColumns() {
  addColumn("temp1", 2);
  addColumn("temp2", 2);
  addColumn("vbat", 2);

  for (size_t s = 0; s < NUM_STAKES; s++) {
    const Stake &stake = STAKES[s];
    for (int re = stake.firstRE; re <= stake.lastRE; re++) {
      for (int ise = stake.firstISE; ise <= stake.lastISE; ise++) {
        addColumn("s" + String(s + 1) + "_re" + String(re) + "_ise" + String(ise), 5);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Google Sheets upload
// ---------------------------------------------------------------------------

// Scans every channel and joins the strongest access point, not the first one found
void wifiInit() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// Drops the current access point and connects from scratch, so after a move the
// ESP32 picks a nearby access point instead of retrying the old one
void wifiRestart() {
  Serial.println("# reconnecting WiFi from scratch");
  WiFi.disconnect();
  delay(200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// One line describing the link, printed when an upload fails
void printWifiStatus() {
  Serial.print("#   wifi status=");
  Serial.print(WiFi.status());
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" rssi=");
    Serial.print(WiFi.RSSI());
    Serial.print(" dBm ap=");
    Serial.print(WiFi.BSSIDstr());
    Serial.print(" ch=");
    Serial.print(WiFi.channel());
    Serial.print(" ip=");
    Serial.print(WiFi.localIP());
  }
  Serial.print(" free_heap=");
  Serial.println(ESP.getFreeHeap());
}

// Waits up to WIFI_TIMEOUT_MS for a connection, kicking a reconnect if it dropped.
bool wifiReady() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.reconnect();
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT_MS) {
    delay(250);
  }
  return WiFi.status() == WL_CONNECTED;
}

// JSON has no NaN, so failed reads are sent as null (an empty cell in the sheet).
String jsonNumber(float value, uint8_t decimals) {
  return isnan(value) ? String("null") : String(value, (unsigned int)decimals);
}

// Body: {"token": "...", "columns": [...], "values": [...]}
String buildPayload(const float *values, size_t n) {
  String body;
  body.reserve(64 + n * 32);
  body += "{\"token\":\"";
  body += SHEETS_TOKEN;
  body += "\",\"columns\":[";
  for (size_t i = 0; i < n; i++) {
    if (i) body += ',';
    body += '"';
    body += columns[i].name;
    body += '"';
  }
  body += "],\"values\":[";
  for (size_t i = 0; i < n; i++) {
    if (i) body += ',';
    body += jsonNumber(values[i], columns[i].decimals);
  }
  body += "]}";
  return body;
}

// Posts one row to the Apps Script web app. Returns the HTTP status (negative on
// connection errors).
int uploadRow(const float *values, size_t n) {
  WiFiClientSecure client;
  client.setInsecure();   // skip certificate pinning; data is not sensitive

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(client, SHEETS_URL)) return -1;

  http.addHeader("Content-Type", "application/json");
  int code = http.POST(buildPayload(values, n));
  http.end();
  return code;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void printCsvRow(const float *values, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (i) Serial.print(',');
    Serial.print(values[i], columns[i].decimals);
  }
  Serial.println();
}

void setup() {
  Serial.begin(SERIAL_BAUD);

  muxInit(ISE_MUX);
  muxInit(RE_MUX);
  pinMode(VBAT_PIN, INPUT);

  Wire.begin();
  adcInit();

  temps1.begin();
  temps2.begin();
  temps1.setWaitForConversion(false);
  temps2.setWaitForConversion(false);

  buildColumns();
  wifiInit();
}

void loop() {
  float values[MAX_COLUMNS];
  size_t n = 0;

  float t1, t2;
  readTemperatures(t1, t2);
  values[n++] = t1;
  values[n++] = t2;
  values[n++] = readBatteryVolts();

  for (size_t s = 0; s < NUM_STAKES; s++) {
    const Stake &stake = STAKES[s];
    for (int re = stake.firstRE; re <= stake.lastRE; re++) {
      for (int ise = stake.firstISE; ise <= stake.lastISE; ise++) {
        if (n < MAX_COLUMNS) values[n++] = readPair(ise, re);
      }
    }
  }

  // Disconnect the electrodes from the ADC between cycles
  muxDisable(ISE_MUX);
  muxDisable(RE_MUX);

  printCsvRow(values, n);

  // Apps Script answers a successful POST with a 302 redirect to its response
  static uint32_t lastUploadMs = 0;
  static uint8_t failures = 0;
  bool ok = false;
  if (!wifiReady()) {
    Serial.println("# upload skipped: no WiFi");
  } else {
    int code = uploadRow(values, n);
    ok = code == 200 || code == 302;
    if (!ok) {
      Serial.print("# upload failed: HTTP ");
      Serial.print(code);
      Serial.print(" (");
      Serial.print(HTTPClient::errorToString(code));
      Serial.println(")");
    }
  }

  if (ok) {
    if (failures) {
      Serial.print("# upload ok again after ");
      Serial.print(failures);
      Serial.println(" failures");
    }
    failures = 0;
    lastUploadMs = millis();
  } else {
    printWifiStatus();
    if (++failures % WIFI_RESET_AFTER == 0) wifiRestart();
    if (millis() - lastUploadMs > REBOOT_AFTER_MS) {
      Serial.println("# nothing uploaded for 5 min, rebooting");
      delay(100);
      ESP.restart();
    }
  }

  delay(CYCLE_PAUSE_MS);
}
