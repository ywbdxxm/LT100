// LT100 第四个例程：双 24 灯环灯光秀
// 灯链：板载 0、1 -> 灯环 A 2–25 -> 灯环 B 26–49
#include <Adafruit_NeoPixel.h>
#include <math.h>

constexpr uint8_t LED_PIN = 23;
constexpr uint8_t RING_A_START = 2;
constexpr uint8_t RING_A_COUNT = 24;
constexpr uint8_t RING_B_START = 26;
constexpr uint8_t RING_B_COUNT = 24;
constexpr uint16_t LED_COUNT = 50;
constexpr uint8_t BRIGHTNESS = 77;  // 30%，两块环一起跑，留供电余量

Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

uint32_t modeStart = 0;
uint8_t mode = 0;
uint8_t headA = 0;
uint8_t headB = 0;

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

void setOnboard(uint16_t hue, uint8_t val) {
  leds.setPixelColor(0, leds.gamma32(leds.ColorHSV(hue, 255, val)));
  leds.setPixelColor(1, leds.gamma32(leds.ColorHSV(hue + 32768, 255, val)));
}

void dualComet(uint32_t now) {
  for (uint8_t i = 0; i < RING_A_COUNT; i++) fadePixel(RING_A_START + i, 40);
  for (uint8_t i = 0; i < RING_B_COUNT; i++) fadePixel(RING_B_START + i, 40);

  uint16_t hue = now * 3;
  headA = (headA + 1) % RING_A_COUNT;
  headB = (headB + RING_B_COUNT - 1) % RING_B_COUNT;

  leds.setPixelColor(RING_A_START + headA, leds.gamma32(leds.ColorHSV(hue, 255, 255)));
  leds.setPixelColor(RING_B_START + headB, leds.gamma32(leds.ColorHSV(hue + 32768, 255, 255)));
  setOnboard(hue, 50);
  leds.show();
}

void vortex(uint32_t now) {
  uint16_t base = now * 4;
  float breath = (sin(now / 700.0) + 1) / 2;
  uint8_t val = 90 + breath * 165;

  for (uint8_t i = 0; i < RING_A_COUNT; i++) {
    uint16_t hue = base + i * 65536UL / RING_A_COUNT;
    leds.setPixelColor(RING_A_START + i, leds.gamma32(leds.ColorHSV(hue, 255, val)));
  }
  for (uint8_t i = 0; i < RING_B_COUNT; i++) {
    uint16_t hue = base - i * 65536UL / RING_B_COUNT + 32768;
    leds.setPixelColor(RING_B_START + i, leds.gamma32(leds.ColorHSV(hue, 255, val)));
  }
  setOnboard(base, 50);
  leds.show();
}

void pulse(uint32_t now) {
  constexpr uint8_t PATH = RING_A_COUNT + RING_B_COUNT;
  uint16_t pos = (now / 35) % (PATH * 2);
  if (pos >= PATH) pos = PATH * 2 - 1 - pos;

  for (uint8_t i = 0; i < RING_A_COUNT; i++) {
    leds.setPixelColor(RING_A_START + i, leds.gamma32(leds.ColorHSV(now * 2 + i * 2000, 255, 35)));
  }
  for (uint8_t i = 0; i < RING_B_COUNT; i++) {
    leds.setPixelColor(RING_B_START + i, leds.gamma32(leds.ColorHSV(now * 2 + 32768 + i * 2000, 255, 35)));
  }

  for (int8_t k = 2; k >= 0; k--) {
    int16_t p = (int16_t)pos - k;
    if (p < 0) continue;
    uint8_t val = (k == 0) ? 255 : (k == 1 ? 90 : 40);
    if (p < RING_A_COUNT) {
      leds.setPixelColor(RING_A_START + p, leds.gamma32(leds.ColorHSV(now * 6, 80, val)));
    } else {
      leds.setPixelColor(RING_B_START + (p - RING_A_COUNT), leds.gamma32(leds.ColorHSV(now * 6 + 32768, 80, val)));
    }
  }
  setOnboard(now * 6, 60);
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
  if (now - modeStart > 7000) {
    mode = (mode + 1) % 3;
    modeStart = now;
  }
  if (mode == 0) dualComet(now);
  else if (mode == 1) vortex(now);
  else pulse(now);
  delay(30);
}
