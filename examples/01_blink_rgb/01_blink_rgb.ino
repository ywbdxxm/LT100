// LT100 第一个例程：板载两颗 WS2812 循环闪烁红、绿、蓝
// 硬件：微雪 Servo Driver with ESP32，灯控 GPIO23，板载 2 颗，外接灯环接在它们之后
#include <Adafruit_NeoPixel.h>

constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 2;   // 只点亮板载两颗；接灯环后改成 26
constexpr uint8_t BRIGHTNESS = 40;  // 0–255，先低亮度，避免刺眼

constexpr uint32_t ON_MS = 400;     // 亮这么久
constexpr uint32_t OFF_MS = 200;    // 灭这么久再换下一个颜色

Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

// 红 → 绿 → 蓝，顺序别改：WS2812 是 GRB，颜色顺序错会红绿颠倒
constexpr uint8_t COLORS[3][3] = {
  {255, 0, 0},   // 红
  {0, 255, 0},   // 绿
  {0, 0, 255},   // 蓝
};

// 所有灯珠一起点亮成同一个颜色
void fill(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < LED_COUNT; i++) {
    leds.setPixelColor(i, leds.Color(r, g, b));
  }
  leds.show();
}

void setup() {
  leds.begin();
  leds.setBrightness(BRIGHTNESS);
  fill(0, 0, 0);  // 上电先全灭，避免残留随机色
}

void loop() {
  for (uint8_t c = 0; c < 3; c++) {
    fill(COLORS[c][0], COLORS[c][1], COLORS[c][2]);
    delay(ON_MS);

    fill(0, 0, 0);
    delay(OFF_MS);
  }
}
