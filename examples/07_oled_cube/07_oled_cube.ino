// LT100 第七个例程：OLED 旋转线框立方体（U8g2）
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

struct Vec3 { float x, y, z; };
const Vec3 CUBE_V[8] = {
  {-1, -1, -1}, {1, -1, -1}, {1, 1, -1}, {-1, 1, -1},
  {-1, -1,  1}, {1, -1,  1}, {1, 1,  1}, {-1, 1,  1}
};
const uint8_t CUBE_E[12][2] = {
  {0, 1}, {1, 2}, {2, 3}, {3, 0},
  {4, 5}, {5, 6}, {6, 7}, {7, 4},
  {0, 4}, {1, 5}, {2, 6}, {3, 7}
};

uint32_t startedAt = 0;
uint32_t lastFrame = 0;
uint32_t lastLed = 0;

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
  int w = oled.getStrWidth("CUBE");
  oled.drawStr((W - w) / 2, 3, "CUBE");

  oled.setFont(u8g2_font_6x10_tf);
  w = oled.getStrWidth("wireframe cube");
  oled.drawStr((W - w) / 2, 18, "wireframe cube");
}

void drawCube(uint32_t t) {
  float a = t * 0.0016f;
  float cy = cosf(a), sy = sinf(a);
  float cx = cosf(a * 0.73f), sx = sinf(a * 0.73f);

  int px[8], py[8];
  for (uint8_t i = 0; i < 8; i++) {
    float x1 = CUBE_V[i].x * cy - CUBE_V[i].z * sy;
    float z1 = CUBE_V[i].x * sy + CUBE_V[i].z * cy;
    float y1 = CUBE_V[i].y * cx - z1 * sx;
    float z2 = CUBE_V[i].y * sx + z1 * cx;

    // 近大远小：z2 越大，投影越小
    float p = 1.0f / (2.4f + z2 * 0.35f);
    px[i] = W / 2 + (int)(x1 * p * 16.0f);
    py[i] = H / 2 + (int)(y1 * p * 16.0f);
  }

  for (uint8_t i = 0; i < 12; i++) {
    uint8_t a0 = CUBE_E[i][0], a1 = CUBE_E[i][1];
    oled.drawLine(px[a0], py[a0], px[a1], py[a1]);
  }
  // 一个亮点跟着顶点转，让线框有“当前焦点”
  oled.drawDisc(px[6], py[6], 1);
}

void drawHud() {
  oled.setDrawColor(0);
  oled.drawBox(0, 0, 38, 9);
  oled.setDrawColor(1);
  oled.setFont(u8g2_font_5x7_tf);
  oled.drawStr(2, 1, "CUBE");
}

void setup() {
  Serial.begin(115200);

  leds.begin();
  leds.setBrightness(45);
  leds.clear();
  leds.show();
  setAmbient(70, 0, 55);

  oled.setBusClock(400000);
  oled.begin();
  oled.setFontPosTop();

  startedAt = millis();
  lastFrame = millis();
  Serial.println("LT100 OLED CUBE");
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
    drawCube(now - startedAt);
    drawHud();
  }
  oled.sendBuffer();
}
