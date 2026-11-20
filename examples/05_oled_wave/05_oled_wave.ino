// LT100 第五个例程：板载 OLED 显示滚动正弦波
// OLED：SSD1306 128×32，I2C 0x3C，SDA=GPIO21，SCL=GPIO22
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_NeoPixel.h>
#include <math.h>

constexpr uint8_t SCREEN_WIDTH = 128;
constexpr uint8_t SCREEN_HEIGHT = 32;
constexpr uint8_t OLED_ADDR = 0x3C;
constexpr uint8_t LED_PIN = 23;
constexpr uint16_t LED_COUNT = 50;

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
Adafruit_NeoPixel leds(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);

  // 清掉上一段灯环例程留在灯链上的最后一帧
  leds.begin();
  leds.clear();
  leds.show();

  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED init failed: check 0x3C / GPIO21/22");
    for (;;) delay(1000);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(34, 4);
  display.print("LT100");
  display.setTextSize(1);
  display.setCursor(29, 22);
  display.print("OLED 128x32");
  display.display();
  delay(1200);
}

void loop() {
  uint32_t now = millis();
  display.clearDisplay();

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("LT100");
  display.setCursor(88, 0);
  display.print(now / 1000);
  display.print("s");

  for (uint8_t x = 0; x < SCREEN_WIDTH; x++) {
    float phase = (x + now / 18.0) * 0.18;
    int16_t y = 23 + sin(phase) * 7;
    display.drawPixel(x, y, SSD1306_WHITE);
    display.drawPixel(x, y + 1, SSD1306_WHITE);
  }

  uint8_t head = (now / 25) % SCREEN_WIDTH;
  int16_t hy = 23 + sin((head + now / 18.0) * 0.18) * 7;
  display.fillCircle(head, hy, 2, SSD1306_WHITE);

  display.display();
  delay(30);
}
