// LT100 第三个例程：外接 24 灯环的彩虹彗星 + 流光
// 灯链：板载 0、1，灯环 2–25；全局亮度 40%，避免超过板载 5V 预算
#include <Adafruit_NeoPixel.h>
#include <math.h>

constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 26;
constexpr uint8_t RING_START = 2;
constexpr uint8_t RING_COUNT = 24;
constexpr uint8_t BRIGHTNESS = 102;  // 40%（102/255）

Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

uint32_t modeStart = 0;
uint8_t mode = 0;
uint8_t head = 0;

void fadePixel(uint8_t idx, uint8_t amount) {
  uint32_t c = leds.getPixelColor(idx);
  uint8_t r = (c >> 16) & 0xFF;
  uint8_t g = (c >> 8) & 0xFF;
  uint8_t b = c & 0xFF;
  r = r * (255 - amount) / 255;
  g = g * (255 - amount) / 255;
  b = b * (255 - amount) / 255;
  leds.setPixelColor(idx, leds.Color(r, g, b));
}

void comet(uint32_t now) {
  for (uint8_t i = 0; i < RING_COUNT; i++) fadePixel(RING_START + i, 40);

  uint16_t hue = now * 3;
  head = (head + 1) % RING_COUNT;
  leds.setPixelColor(RING_START + head, leds.gamma32(leds.ColorHSV(hue, 255, 255)));

  leds.setPixelColor(0, leds.gamma32(leds.ColorHSV(hue, 255, 60)));
  leds.setPixelColor(1, leds.gamma32(leds.ColorHSV(hue + 32768, 255, 60)));
  leds.show();
}

void rainbow(uint32_t now) {
  uint16_t base = now * 4;
  float breath = (sin(now / 800.0) + 1) / 2;
  uint8_t val = 90 + breath * 165;

  for (uint8_t i = 0; i < RING_COUNT; i++) {
    uint16_t hue = base + i * 65536UL / RING_COUNT;
    leds.setPixelColor(RING_START + i, leds.gamma32(leds.ColorHSV(hue, 255, val)));
  }
  leds.setPixelColor(0, leds.gamma32(leds.ColorHSV(base + 32768, 255, 60)));
  leds.setPixelColor(1, leds.gamma32(leds.ColorHSV(base, 255, 60)));
  leds.show();
}

void setup() {
  leds.begin();
  leds.setBrightness(BRIGHTNESS);
  leds.clear();
  leds.show();
  modeStart = millis();
}

void loop() {
  uint32_t now = millis();
  if (now - modeStart > 8000) {
    mode = (mode + 1) % 2;
    modeStart = now;
  }
  if (mode == 0) comet(now);
  else rainbow(now);
  delay(30);
}
