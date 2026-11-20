// LT100 第一个例程：板载两颗 WS2812 交替闪烁
// 硬件：微雪 Servo Driver with ESP32，灯控 GPIO23，板载 2 颗，外接灯环接在它们之后
#include <Adafruit_NeoPixel.h>

constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 2;   // 只点亮板载两颗；接灯环后改成 26
constexpr uint8_t BRIGHTNESS = 40;  // 0–255，先低亮度，避免刺眼

Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  leds.begin();
  leds.setBrightness(BRIGHTNESS);
  leds.clear();
  leds.show();
}

void loop() {
  leds.setPixelColor(0, leds.Color(255, 0, 0));  // 0 号：红
  leds.setPixelColor(1, leds.Color(0, 0, 255));  // 1 号：蓝
  leds.show();
  delay(400);

  leds.clear();
  leds.show();
  delay(200);
}
