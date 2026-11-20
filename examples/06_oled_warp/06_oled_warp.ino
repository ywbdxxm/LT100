// LT100 第六个例程：OLED 星际穿越（U8g2）
// 屏幕：SSD1306 128×32，I2C 0x3C，SDA=GPIO21，SCL=GPIO22
#include <Wire.h>
#include <U8g2lib.h>
#include <Adafruit_NeoPixel.h>
#include <math.h>

// 硬件 I2C：参数顺序是 reset, clock, data
U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, 22, 21);

constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 50;
Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

constexpr uint8_t W = 128;
constexpr uint8_t H = 32;
constexpr uint32_t FRAME_MS = 33;
constexpr uint32_t TITLE_MS = 900;

struct Star { float x, y, z, v; };
constexpr uint8_t STAR_COUNT = 58;
Star stars[STAR_COUNT];

uint32_t startedAt = 0;
uint32_t lastFrame = 0;
uint32_t lastLed = 0;

void resetStar(Star &s, bool far) {
  s.x = random(-1400, 1401) / 1000.0f;
  s.y = random(-900, 901) / 1000.0f;
  s.z = far ? 1.0f : random(600, 1001) / 1000.0f;
  s.v = random(8, 23) / 1000.0f;
}

void resetStars() {
  for (uint8_t i = 0; i < STAR_COUNT; i++) resetStar(stars[i], true);
}

void setAmbient(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < LED_COUNT; i++) leds.setPixelColor(i, leds.Color(r, g, b));
  leds.show();
}

void breatheLeds(uint32_t now) {
  if (now - lastLed < 70) return;
  lastLed = now;
  leds.setBrightness(30 + (uint8_t)((sinf(now * 0.0025f) + 1.0f) * 15.0f));
  leds.show();
}

void drawTitle() {
  oled.drawFrame(0, 0, W, H);
  oled.setFont(u8g2_font_helvB12_tf);
  int w = oled.getStrWidth("WARP");
  oled.drawStr((W - w) / 2, 3, "WARP");

  oled.setFont(u8g2_font_6x10_tf);
  w = oled.getStrWidth("3D starfield");
  oled.drawStr((W - w) / 2, 18, "3D starfield");
}

void drawWarp() {
  for (uint8_t i = 0; i < STAR_COUNT; i++) {
    Star &s = stars[i];
    s.z -= s.v;
    if (s.z < 0.18f) { resetStar(s, false); continue; }

    float f = 1.0f / s.z;
    int x = W / 2 + (int)(s.x * f * 34.0f);
    int y = H / 2 + (int)(s.y * f * 34.0f);

    if (x < -8 || x > W + 8 || y < -8 || y > H + 8) {
      resetStar(s, false);
      continue;
    }
    if (x < 0 || x >= W || y < 0 || y >= H) continue;

    if (s.z < 0.58f) {
      // 近处的星星拉出短拖尾，像在往前冲
      float pf = 1.0f / (s.z + 0.045f);
      int px = W / 2 + (int)(s.x * pf * 34.0f);
      int py = H / 2 + (int)(s.y * pf * 34.0f);
      if (px >= 0 && px < W && py >= 0 && py < H) {
        oled.drawLine(px, py, x, y);
      } else {
        oled.drawPixel(x, y);
      }
    } else {
      oled.drawPixel(x, y);
    }
  }
}

void drawHud() {
  oled.setDrawColor(0);
  oled.drawBox(0, 0, 38, 9);
  oled.setDrawColor(1);
  oled.setFont(u8g2_font_5x7_tf);
  oled.drawStr(2, 1, "WARP");
}

void setup() {
  Serial.begin(115200);
  randomSeed(analogRead(0));

  leds.begin();
  leds.setBrightness(45);
  leds.clear();
  leds.show();
  setAmbient(0, 18, 70);

  oled.setBusClock(400000);
  oled.begin();
  oled.setFontPosTop();

  resetStars();
  startedAt = millis();
  lastFrame = millis();
  Serial.println("LT100 OLED WARP");
}

void loop() {
  uint32_t now = millis();
  if (now - lastFrame < FRAME_MS) {
    delay(1);
    return;
  }
  lastFrame = now;
  breatheLeds(now);

  oled.clearBuffer();
  if (now - startedAt < TITLE_MS) {
    drawTitle();
  } else {
    drawWarp();
    drawHud();
  }
  oled.sendBuffer();
}
