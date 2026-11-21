// LT100 第八个例程：串口控制台
// 电脑通过 USB 串口发命令 → OLED 显示 / 灯环执行 → 串口回状态
// 串口：UART0，115200 8N1（CP2102 转 USB）
#include <Wire.h>
#include <U8g2lib.h>
#include <Adafruit_NeoPixel.h>
#include <Esp.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, 22, 21);

constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 50;  // 板载2 + 两个24灯环；只接一个也能跑
Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

constexpr uint8_t W = 128;
constexpr uint8_t H = 32;
constexpr uint8_t MAX_LINE = 96;
constexpr uint8_t MAX_TEXT = 20;
constexpr uint8_t MAX_RESP = 192;
constexpr uint8_t BRIGHT_MAX = 40;
constexpr uint32_t OLED_MS = 50;
constexpr uint32_t LED_MS = 33;
constexpr uint32_t FLASH_MS = 60;

enum LedMode : uint8_t { MODE_SOLID, MODE_RAINBOW, MODE_BREATHE, MODE_OFF };
LedMode mode = MODE_SOLID;
uint8_t colorR = 255, colorG = 102, colorB = 0;
uint8_t bright = 20;
char textLine[MAX_TEXT + 1] = "";
uint32_t textUntil = 0;

char lineBuf[MAX_LINE + 1];
uint8_t lineLen = 0;
bool overflow = false;

char lastCmd[MAX_LINE + 1] = "BOOT";
char lastResp[MAX_RESP + 1] = "READY";

uint32_t rxBytes = 0, txBytes = 0, cmdCount = 0;
uint32_t rxFlashUntil = 0, txFlashUntil = 0;
uint32_t bootAt = 0, lastOled = 0, lastLed = 0, lastStream = 0;
uint16_t hue = 0;
bool streamOn = false;

const char *modeName(LedMode m) {
  if (m == MODE_SOLID) return "SOLID";
  if (m == MODE_RAINBOW) return "RAINBOW";
  if (m == MODE_BREATHE) return "BREATHE";
  return "OFF";
}

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

bool parseColor(const char *s, uint8_t &r, uint8_t &g, uint8_t &b) {
  if (*s == '#') s++;
  if (strlen(s) != 6) return false;
  for (uint8_t i = 0; i < 6; i++) {
    if (!isxdigit((unsigned char)s[i])) return false;
  }
  long v = strtol(s, nullptr, 16);
  r = (v >> 16) & 0xFF;
  g = (v >> 8) & 0xFF;
  b = v & 0xFF;
  return true;
}

bool asciiJsonSafe(const char *s) {
  for (; *s; s++) {
    uint8_t c = (uint8_t)*s;
    if (c < 32 || c > 126 || c == '"' || c == '\\') return false;
  }
  return true;
}

bool textActive(uint32_t now) {
  return textLine[0] != 0 && (int32_t)(now - textUntil) < 0;
}

void sendRaw(const char *msg) {
  Serial.println(msg);
  txBytes += strlen(msg) + 2;  // println 补 \r\n
  txFlashUntil = millis() + FLASH_MS;
}

void reply(const char *msg) {
  strncpy(lastResp, msg, MAX_RESP);
  lastResp[MAX_RESP] = 0;
  sendRaw(msg);
}

void sendInfo() {
  uint64_t mac = ESP.getEfuseMac();
  char buf[224];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"info\",\"chip\":\"%s\",\"mac\":\"%04X%08X\",\"flash\":%u,\"sdk\":\"%s\",\"heap\":%u}",
           ESP.getChipModel(),
           (unsigned)((mac >> 32) & 0xFFFF), (unsigned)(mac & 0xFFFFFFFF),
           (unsigned)ESP.getFlashChipSize(), ESP.getSdkVersion(),
           (unsigned)ESP.getFreeHeap());
  reply(buf);
}

void sendStat(bool asReply, uint32_t now) {
  char buf[224];
  const char *text = textActive(now) ? textLine : "";
  snprintf(buf, sizeof(buf),
           "{\"type\":\"stat\",\"up_ms\":%lu,\"heap\":%u,\"rx\":%lu,\"tx\":%lu,"
           "\"cmds\":%lu,\"mode\":\"%s\",\"color\":\"#%02X%02X%02X\","
           "\"bright\":%u,\"text\":\"%s\"}",
           (unsigned long)now, (unsigned)ESP.getFreeHeap(),
           (unsigned long)rxBytes, (unsigned long)txBytes, (unsigned long)cmdCount,
           modeName(mode), (unsigned)colorR, (unsigned)colorG, (unsigned)colorB,
           (unsigned)bright, text);
  if (asReply) reply(buf);
  else sendRaw(buf);
}

void handleLine(char *line) {
  char *p = line;
  while (*p == ' ' || *p == '\t') p++;
  char *end = p + strlen(p);
  while (end > p && (end[-1] == ' ' || end[-1] == '\t')) *--end = 0;
  if (!*p) return;

  cmdCount++;
  strncpy(lastCmd, p, MAX_LINE);
  lastCmd[MAX_LINE] = 0;

  char *arg = p;
  while (*arg && *arg != ' ' && *arg != '\t') arg++;
  if (*arg) {
    *arg++ = 0;
    while (*arg == ' ' || *arg == '\t') arg++;
  }

  if (ieq(p, "HELP")) {
    reply("OK commands: HELP PING INFO STAT MODE COLOR BRIGHT TEXT CLEAR STREAM");
    return;
  }
  if (ieq(p, "PING")) {
    char buf[32];
    snprintf(buf, sizeof(buf), "PONG %lu", (unsigned long)millis());
    reply(buf);
    return;
  }
  if (ieq(p, "INFO")) {
    sendInfo();
    return;
  }
  if (ieq(p, "STAT")) {
    sendStat(true, millis());
    return;
  }
  if (ieq(p, "MODE")) {
    if (ieq(arg, "SOLID")) mode = MODE_SOLID;
    else if (ieq(arg, "RAINBOW")) mode = MODE_RAINBOW;
    else if (ieq(arg, "BREATHE")) mode = MODE_BREATHE;
    else if (ieq(arg, "OFF")) mode = MODE_OFF;
    else {
      reply("ERR 02 mode must be SOLID|RAINBOW|BREATHE|OFF");
      return;
    }
    char buf[32];
    snprintf(buf, sizeof(buf), "OK mode=%s", modeName(mode));
    reply(buf);
    return;
  }
  if (ieq(p, "COLOR")) {
    uint8_t r, g, b;
    if (!arg || !*arg || !parseColor(arg, r, g, b)) {
      reply("ERR 02 color must be RRGGBB");
      return;
    }
    colorR = r;
    colorG = g;
    colorB = b;
    mode = MODE_SOLID;
    char buf[32];
    snprintf(buf, sizeof(buf), "OK color=#%02X%02X%02X", colorR, colorG, colorB);
    reply(buf);
    return;
  }
  if (ieq(p, "BRIGHT")) {
    long v;
    if (!parseInt(arg, v) || v < 0 || v > BRIGHT_MAX) {
      reply("ERR 03 bright must be 0..40");
      return;
    }
    bright = (uint8_t)v;
    char buf[24];
    snprintf(buf, sizeof(buf), "OK bright=%u", (unsigned)bright);
    reply(buf);
    return;
  }
  if (ieq(p, "TEXT")) {
    if (!arg || !*arg) {
      reply("ERR 02 missing text");
      return;
    }
    if (!asciiJsonSafe(arg)) {
      reply("ERR 02 text must be printable ascii without quotes");
      return;
    }
    strncpy(textLine, arg, MAX_TEXT);
    textLine[MAX_TEXT] = 0;
    textUntil = millis() + 5000;
    char buf[48];
    snprintf(buf, sizeof(buf), "OK text=%s", textLine);
    reply(buf);
    return;
  }
  if (ieq(p, "CLEAR")) {
    textLine[0] = 0;
    textUntil = 0;
    reply("OK text cleared");
    return;
  }
  if (ieq(p, "STREAM")) {
    if (ieq(arg, "1")) {
      streamOn = true;
      lastStream = millis();
      reply("OK stream=1");
    } else if (ieq(arg, "0")) {
      streamOn = false;
      reply("OK stream=0");
    } else {
      reply("ERR 02 stream must be 0 or 1");
    }
    return;
  }
  reply("ERR 01 unknown command");
}

void pollSerial(uint32_t now) {
  while (Serial.available()) {
    int c = Serial.read();
    if (c < 0) break;
    rxBytes++;
    rxFlashUntil = now + FLASH_MS;

    if (c == '\r') continue;
    if (c == '\n') {
      if (overflow) {
        overflow = false;
        lineLen = 0;
        reply("ERR 05 line too long");
      } else {
        lineBuf[lineLen] = 0;
        if (lineLen > 0) handleLine(lineBuf);
        lineLen = 0;
      }
    } else if (lineLen < MAX_LINE) {
      lineBuf[lineLen++] = (char)c;
    } else {
      overflow = true;
    }
  }
}

uint8_t scale8(uint8_t v, uint8_t s) {
  return (uint16_t)v * s / 255;
}

void updateLeds(uint32_t now) {
  if (now - lastLed < LED_MS) return;
  lastLed = now;

  leds.setBrightness((uint8_t)map(bright, 0, BRIGHT_MAX, 0, 102));
  uint8_t breath = (uint8_t)((sinf(now * 0.002f) + 1.0f) * 127.5f);

  for (uint16_t i = 0; i < LED_COUNT; i++) {
    uint8_t r = 0, g = 0, b = 0;
    if (mode == MODE_SOLID) {
      r = colorR; g = colorG; b = colorB;
    } else if (mode == MODE_RAINBOW) {
      uint32_t c = leds.ColorHSV((uint16_t)(hue + i * 1310), 255, 255);
      r = (c >> 16) & 0xFF;
      g = (c >> 8) & 0xFF;
      b = c & 0xFF;
    } else if (mode == MODE_BREATHE) {
      r = scale8(colorR, breath);
      g = scale8(colorG, breath);
      b = scale8(colorB, breath);
    }
    leds.setPixelColor(i, r, g, b);
  }

  if ((int32_t)(now - rxFlashUntil) < 0) leds.setPixelColor(0, 0, 0, 255);
  if ((int32_t)(now - txFlashUntil) < 0) leds.setPixelColor(1, 0, 255, 0);
  leds.show();

  if (mode == MODE_RAINBOW) hue += 256;
}

void drawSplash() {
  oled.drawFrame(0, 0, W, H);
  oled.setFont(u8g2_font_helvB12_tf);
  int w = oled.getStrWidth("LT100 SERIAL");
  oled.drawStr((W - w) / 2, 3, "LT100 SERIAL");
  oled.setFont(u8g2_font_6x10_tf);
  w = oled.getStrWidth("115200 8N1");
  oled.drawStr((W - w) / 2, 18, "115200 8N1");
}

void drawConsole(uint32_t now) {
  char line1[24], line2[24], line3[24];
  snprintf(line1, sizeof(line1), "M:%s B:%u", modeName(mode), (unsigned)bright);
  snprintf(line2, sizeof(line2), "> %.20s", lastCmd);
  const char *resp = textActive(now) ? textLine : lastResp;
  snprintf(line3, sizeof(line3), "%.20s", resp);

  oled.setFont(u8g2_font_6x10_tf);
  oled.drawStr(0, 0, line1);
  oled.drawStr(0, 11, line2);
  oled.drawStr(0, 22, line3);
}

void updateOled(uint32_t now) {
  if (now - lastOled < OLED_MS) return;
  lastOled = now;
  oled.clearBuffer();
  if (now - bootAt < 1000) drawSplash();
  else drawConsole(now);
  oled.sendBuffer();
}

void setup() {
  Serial.begin(115200);

  leds.begin();
  leds.setBrightness((uint8_t)map(bright, 0, BRIGHT_MAX, 0, 102));
  leds.clear();
  leds.show();

  oled.setBusClock(400000);
  oled.begin();
  oled.setFontPosTop();

  bootAt = millis();
  lastOled = 0;
  lastLed = 0;
  lastStream = millis();

  sendRaw("LT100 SERIAL CONSOLE");
  sendRaw("115200 8N1 | type HELP");
  Serial.println();
  txBytes += 2;
}

void loop() {
  uint32_t now = millis();
  pollSerial(now);

  if (streamOn && (uint32_t)(now - lastStream) >= 1000) {
    lastStream = now;
    sendStat(false, now);
  }

  updateLeds(now);
  updateOled(now);
}
