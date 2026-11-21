// LT100 第九个例程：舵机基础（先读位置，再标定限位）
// 上电只扫描和读状态，不自动转动；MOVE 只允许在标定过的安全区间内。
// 舵机总线：UART1，GPIO18=RX，GPIO19=TX，1Mbps
// USB 串口：UART0，115200 8N1，行尾 Newline
#include <Wire.h>
#include <U8g2lib.h>
#include <SCServo.h>
#include <Preferences.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, 22, 21);
SMS_STS bus;
Preferences prefs;

constexpr uint8_t SERVO_RX = 18;
constexpr uint8_t SERVO_TX = 19;
constexpr uint8_t SCAN_MAX = 3;        // LT100 的 ID 是 1/2/3
constexpr uint8_t CMD_MAX = 80;
constexpr uint16_t DEFAULT_SPEED = 250;
constexpr uint16_t MAX_SPEED = 600;    // 限制速度，降低撞机伤害
constexpr uint8_t MOVE_ACC = 20;
constexpr int LIMIT_MARGIN = 40;       // 标定端点向内收 40 刻度（约 3.5°）

struct ServoState {
  bool online;
  int pos;
  int volt;    // 0.1V，120 = 12.0V
  int temp;    // °C
  int load;    // 0..1000，带符号
};

struct JointLimit {
  int minRaw;  // -1 = 未标定
  int maxRaw;
};

ServoState servo[SCAN_MAX + 1];
JointLimit limit[SCAN_MAX + 1];
uint8_t onlineCount = 0;

char lineBuf[CMD_MAX + 1];
uint8_t lineLen = 0;
bool overflow = false;
uint32_t lastOled = 0;

bool ieq(const char *a, const char *b) {
  while (*a && *b) {
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return false;
    a++;
    b++;
  }
  return *a == 0 && *b == 0;
}

bool parseInt(const char *s, long &v) {
  if (!s || !*s) return false;
  char *end = nullptr;
  v = strtol(s, &end, 10);
  return end != s && *end == 0;
}

void reply(const char *msg) {
  Serial.println(msg);
}

bool hasLimit(uint8_t id) {
  return limit[id].minRaw >= 0 && limit[id].maxRaw >= 0 &&
         limit[id].maxRaw - limit[id].minRaw > 2 * LIMIT_MARGIN;
}

int safeMin(uint8_t id) { return limit[id].minRaw + LIMIT_MARGIN; }
int safeMax(uint8_t id) { return limit[id].maxRaw - LIMIT_MARGIN; }

void keyFor(char *out, size_t n, const char *prefix, uint8_t id) {
  snprintf(out, n, "%s%u", prefix, id);
}

void saveLimit(uint8_t id) {
  char kMin[12], kMax[12], kSet[12];
  keyFor(kMin, sizeof(kMin), "min", id);
  keyFor(kMax, sizeof(kMax), "max", id);
  keyFor(kSet, sizeof(kSet), "set", id);
  prefs.begin("lt100servo", false);
  prefs.putInt(kMin, limit[id].minRaw);
  prefs.putInt(kMax, limit[id].maxRaw);
  prefs.putBool(kSet, limit[id].minRaw >= 0 || limit[id].maxRaw >= 0);
  prefs.end();
}

void clearLimit(uint8_t id) {
  char kMin[12], kMax[12], kSet[12];
  keyFor(kMin, sizeof(kMin), "min", id);
  keyFor(kMax, sizeof(kMax), "max", id);
  keyFor(kSet, sizeof(kSet), "set", id);
  prefs.begin("lt100servo", false);
  prefs.remove(kMin);
  prefs.remove(kMax);
  prefs.remove(kSet);
  prefs.end();
  limit[id].minRaw = -1;
  limit[id].maxRaw = -1;
}

void loadLimits() {
  prefs.begin("lt100servo", true);
  for (uint8_t id = 1; id <= SCAN_MAX; id++) {
    char kMin[12], kMax[12], kSet[12];
    keyFor(kMin, sizeof(kMin), "min", id);
    keyFor(kMax, sizeof(kMax), "max", id);
    keyFor(kSet, sizeof(kSet), "set", id);
    bool set = prefs.getBool(kSet, false);
    limit[id].minRaw = set ? prefs.getInt(kMin, -1) : -1;
    limit[id].maxRaw = set ? prefs.getInt(kMax, -1) : -1;
  }
  prefs.end();
}

bool readServo(uint8_t id) {
  servo[id] = ServoState();
  if (bus.FeedBack(id) == -1) return false;
  servo[id].online = true;
  servo[id].pos = bus.ReadPos(-1);
  servo[id].volt = bus.ReadVoltage(-1);
  servo[id].temp = bus.ReadTemper(-1);
  servo[id].load = bus.ReadLoad(-1);
  return true;
}

void printLimit(uint8_t id) {
  if (hasLimit(id)) {
    Serial.printf("  ID%u limits raw=%d..%d safe=%d..%d\n",
                  id, limit[id].minRaw, limit[id].maxRaw, safeMin(id), safeMax(id));
  } else if (limit[id].minRaw >= 0) {
    Serial.printf("  ID%u limits min=%d, MAX unset (MOVE disabled)\n",
                  id, limit[id].minRaw);
  } else if (limit[id].maxRaw >= 0) {
    Serial.printf("  ID%u limits MAX=%d, min unset (MOVE disabled)\n",
                  id, limit[id].maxRaw);
  } else {
    Serial.printf("  ID%u limits UNSET (MOVE disabled)\n", id);
  }
}

void scanAll() {
  onlineCount = 0;
  Serial.println("SCAN servo bus (ID 1..3):");
  for (uint8_t id = 1; id <= SCAN_MAX; id++) {
    if (!readServo(id)) {
      Serial.printf("  ID%u offline\n", id);
      continue;
    }
    onlineCount++;
    Serial.printf("  ID%u pos=%d v=%.1fV t=%dC load=%d\n",
                  id, servo[id].pos, servo[id].volt / 10.0,
                  servo[id].temp, servo[id].load);
  }
  Serial.printf("SCAN done: %u/%u online\n", onlineCount, SCAN_MAX);
}

void slot(char *buf, size_t n, uint8_t id) {
  if (servo[id].online) snprintf(buf, n, "%u:%04d", id, servo[id].pos);
  else snprintf(buf, n, "%u:----", id);
}

void drawOled() {
  char s1[12], s2[12], s3[12], l0[24], l1[24], l2[24];
  uint8_t online = 0, calibrated = 0;
  for (uint8_t id = 1; id <= SCAN_MAX; id++) {
    if (servo[id].online) online++;
    if (hasLimit(id)) calibrated++;
  }
  slot(s1, sizeof(s1), 1);
  slot(s2, sizeof(s2), 2);
  slot(s3, sizeof(s3), 3);
  snprintf(l0, sizeof(l0), "SERVO %u/%u %s", online, SCAN_MAX,
           calibrated ? "CAL" : "RAW");
  snprintf(l1, sizeof(l1), "%s %s", s1, s2);
  if (servo[1].online) snprintf(l2, sizeof(l2), "%s V:%.1f", s3, servo[1].volt / 10.0);
  else snprintf(l2, sizeof(l2), "%s V:--.-", s3);

  oled.clearBuffer();
  oled.setFont(u8g2_font_5x7_tf);
  oled.drawStr(0, 8, l0);
  oled.drawStr(0, 19, l1);
  oled.drawStr(0, 30, l2);
  oled.sendBuffer();
}

void help() {
  Serial.println("Commands:");
  Serial.println("  SCAN                      read ID 1..3, no motion");
  Serial.println("  READ <id>                 read one servo");
  Serial.println("  LIMITS                    show stored limits");
  Serial.println("  MARK <id> MIN|MAX         save current position as endpoint");
  Serial.println("  TORQUE <id> ON|OFF        OFF lets you move the joint by hand");
  Serial.println("  CLEAR <id>                erase that joint's limits");
  Serial.println("  MOVE <id> <pos> [speed]   only inside safe limits");
  Serial.println("  speed 1..600, default 250; no motion if uncalibrated");
  reply("OK help");
}

void doRead(char *arg) {
  long id;
  if (!parseInt(arg, id) || id < 1 || id > SCAN_MAX) {
    reply("ERR 02 usage: READ <id 1..3>");
    return;
  }
  if (!readServo((uint8_t)id)) {
    reply("ERR 06 servo offline");
    return;
  }
  char msg[96];
  snprintf(msg, sizeof(msg), "ID%ld pos=%d v=%.1fV t=%dC load=%d",
           id, servo[id].pos, servo[id].volt / 10.0,
           servo[id].temp, servo[id].load);
  reply(msg);
}

void doLimits() {
  Serial.println("LIMITS (raw encoder ticks, 0..4095):");
  for (uint8_t id = 1; id <= SCAN_MAX; id++) printLimit(id);
  reply("OK limits");
}

void doMark(char *idArg, char *which) {
  long id;
  if (!parseInt(idArg, id) || id < 1 || id > SCAN_MAX || !which) {
    reply("ERR 02 usage: MARK <id 1..3> MIN|MAX");
    return;
  }
  if (!readServo((uint8_t)id)) {
    reply("ERR 06 servo offline");
    return;
  }
  int pos = servo[id].pos;
  bool isMin = ieq(which, "MIN");
  bool isMax = ieq(which, "MAX");
  if (!isMin && !isMax) {
    reply("ERR 02 endpoint must be MIN or MAX");
    return;
  }

  int newMin = isMin ? pos : limit[id].minRaw;
  int newMax = isMax ? pos : limit[id].maxRaw;
  if (newMin >= 0 && newMax >= 0 && newMax - newMin <= 2 * LIMIT_MARGIN) {
    char msg[96];
    snprintf(msg, sizeof(msg),
             "ERR 08 endpoints too close: raw %d..%d, need > %d ticks",
             newMin, newMax, 2 * LIMIT_MARGIN);
    reply(msg);
    return;
  }

  limit[id].minRaw = newMin;
  limit[id].maxRaw = newMax;
  saveLimit((uint8_t)id);
  char msg[96];
  if (hasLimit((uint8_t)id)) {
    snprintf(msg, sizeof(msg), "OK mark ID%ld %s raw=%d safe=%d..%d",
             id, isMin ? "MIN" : "MAX", pos, safeMin((uint8_t)id), safeMax((uint8_t)id));
  } else {
    snprintf(msg, sizeof(msg), "OK mark ID%ld %s raw=%d; mark the other endpoint",
             id, isMin ? "MIN" : "MAX", pos);
  }
  reply(msg);
}

void doTorque(char *idArg, char *which) {
  long id;
  if (!parseInt(idArg, id) || id < 1 || id > SCAN_MAX || !which) {
    reply("ERR 02 usage: TORQUE <id 1..3> ON|OFF");
    return;
  }
  bool on = ieq(which, "ON");
  bool off = ieq(which, "OFF");
  if (!on && !off) {
    reply("ERR 02 torque must be ON or OFF");
    return;
  }
  if (!readServo((uint8_t)id)) {
    reply("ERR 06 servo offline");
    return;
  }
  if (!bus.EnableTorque((uint8_t)id, on ? 1 : 0)) {
    reply("ERR 07 no ACK from servo");
    return;
  }
  char msg[64];
  snprintf(msg, sizeof(msg), "OK torque ID%ld %s", id, on ? "ON" : "OFF");
  reply(msg);
  if (!on) Serial.println("  support the arm; torque is off now");
}

void doClear(char *arg) {
  long id;
  if (!parseInt(arg, id) || id < 1 || id > SCAN_MAX) {
    reply("ERR 02 usage: CLEAR <id 1..3>");
    return;
  }
  clearLimit((uint8_t)id);
  reply("OK clear limits");
}

void doMove(char *idArg, char *posArg, char *speedArg) {
  long id, pos, speed = DEFAULT_SPEED;
  if (!idArg || !posArg) {
    reply("ERR 02 usage: MOVE <id> <pos> [speed]");
    return;
  }
  if (!parseInt(idArg, id) || !parseInt(posArg, pos) ||
      (speedArg && !parseInt(speedArg, speed))) {
    reply("ERR 02 bad number");
    return;
  }
  if (id < 1 || id > SCAN_MAX || pos < 0 || pos > 4095 ||
      speed < 1 || speed > MAX_SPEED) {
    char msg[96];
    snprintf(msg, sizeof(msg), "ERR 03 range: id 1..3, pos 0..4095, speed 1..%u",
             MAX_SPEED);
    reply(msg);
    return;
  }
  if (!hasLimit((uint8_t)id)) {
    reply("ERR 09 uncalibrated; use MARK <id> MIN and MARK <id> MAX first");
    return;
  }
  if (pos < safeMin((uint8_t)id) || pos > safeMax((uint8_t)id)) {
    char msg[96];
    snprintf(msg, sizeof(msg), "ERR 10 target %ld outside safe %d..%d",
             pos, safeMin((uint8_t)id), safeMax((uint8_t)id));
    reply(msg);
    return;
  }
  if (!readServo((uint8_t)id)) {
    reply("ERR 06 servo offline");
    return;
  }
  int from = servo[id].pos;
  if (from < safeMin((uint8_t)id) || from > safeMax((uint8_t)id)) {
    Serial.println("WARN current position is outside safe range; move slowly and watch");
  }
  if (!bus.WritePosEx((uint8_t)id, (int16_t)pos, (uint16_t)speed, MOVE_ACC)) {
    reply("ERR 07 no ACK from servo");
    return;
  }
  char msg[112];
  snprintf(msg, sizeof(msg),
           "OK move id=%ld from=%d pos=%ld speed=%ld safe=%d..%d",
           id, from, pos, speed, safeMin((uint8_t)id), safeMax((uint8_t)id));
  reply(msg);
}

void handleLine(char *s) {
  char *cmd = strtok(s, " ");
  if (!cmd) return;
  if (ieq(cmd, "HELP")) {
    help();
  } else if (ieq(cmd, "SCAN")) {
    scanAll();
  } else if (ieq(cmd, "READ")) {
    doRead(strtok(nullptr, " "));
  } else if (ieq(cmd, "LIMITS")) {
    doLimits();
  } else if (ieq(cmd, "MARK")) {
    char *id = strtok(nullptr, " ");
    char *which = strtok(nullptr, " ");
    doMark(id, which);
  } else if (ieq(cmd, "TORQUE")) {
    char *id = strtok(nullptr, " ");
    char *which = strtok(nullptr, " ");
    doTorque(id, which);
  } else if (ieq(cmd, "CLEAR")) {
    doClear(strtok(nullptr, " "));
  } else if (ieq(cmd, "MOVE")) {
    char *id = strtok(nullptr, " ");
    char *pos = strtok(nullptr, " ");
    char *speed = strtok(nullptr, " ");
    doMove(id, pos, speed);
  } else {
    reply("ERR 01 unknown command; send HELP");
  }
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(1000000, SERIAL_8N1, SERVO_RX, SERVO_TX);
  bus.pSerial = &Serial1;
  bus.IOTimeOut = 20;  // 1Mbps replies are sub-ms; don't block 100ms on absent IDs
  oled.begin();
  oled.setBusClock(400000);
  loadLimits();

  delay(300);
  Serial.println();
  Serial.println("LT100 servo basic: read positions, then calibrate limits");
  Serial.println("UART1 GPIO18=RX GPIO19=TX 1Mbps; USB serial 115200");
  Serial.println("MOTION LOCKED: MOVE only works after MARK MIN and MAX per joint.");
  Serial.println("12V must be on for servos; support the arm while calibrating.");
  scanAll();
  doLimits();
  drawOled();
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      lineBuf[lineLen] = 0;
      if (overflow) {
        reply("ERR 05 line too long");
      } else if (lineLen) {
        handleLine(lineBuf);
      }
      lineLen = 0;
      overflow = false;
    } else if (lineLen < CMD_MAX) {
      lineBuf[lineLen++] = c;
    } else {
      overflow = true;
    }
  }

  uint32_t now = millis();
  if (now - lastOled >= 100) {
    lastOled = now;
    drawOled();
  }
}
