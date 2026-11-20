// LT100 第二个例程：板载两颗 WS2812 呼吸彩虹
// 两颗取互补色相，色相慢慢转，亮度按正弦起伏
#include <Adafruit_NeoPixel.h>
#include <math.h>

constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 2;
constexpr uint8_t MAX_BRIGHTNESS = 90;  // 0–255

Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  leds.begin();
  leds.clear();
  leds.show();
}

void loop() {
  uint32_t now = millis();
  uint16_t hue = now * 5;                      // 色相转速：约 13 秒一圈
  float breath = (sin(now / 700.0) + 1) / 2;   // 0–1，约 4.4 秒一次
  uint8_t value = 15 + breath * (MAX_BRIGHTNESS - 15);

  leds.setPixelColor(0, leds.gamma32(leds.ColorHSV(hue, 255, value)));
  leds.setPixelColor(1, leds.gamma32(leds.ColorHSV(hue + 32768, 255, value)));
  leds.show();
  delay(16);
}
