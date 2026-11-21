// LT100 common-platform lamp firmware.
// Safety: no motion at boot; POSE is rejected until calibration is complete,
// all three servos are online and torque has been explicitly enabled.
#include <Arduino.h>
#include <LT100Board.h>
#include <LT100Core.h>
#include <SCServo.h>
#include <U8g2lib.h>
#include <Wire.h>

#include <stdio.h>

namespace {

constexpr uint8_t SERVO_RX = 18;
constexpr uint8_t SERVO_TX = 19;
constexpr uint32_t SERVO_BAUD = 1000000;
constexpr unsigned long SERVO_TIMEOUT_MS = 20;
constexpr uint32_t OLED_PERIOD_MS = 200;

U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, 22, 21);
SMS_STS servoBus;

lt100board::ScsServoBus servoHal(servoBus);
lt100board::PreferencesStorage storage;
lt100board::ArduinoClock clockSource;
lt100board::SerialOutput output(Serial);
lt100::Core core(servoHal, clockSource, storage, output);
lt100board::LineReader lineReader(core, Serial);

uint32_t lastOledMs = 0;

const char* modeText(lt100::Mode mode) {
  switch (mode) {
    case lt100::Mode::Boot: return "BOOT";
    case lt100::Mode::Uncal: return "UNCAL";
    case lt100::Mode::Calibrating: return "CAL";
    case lt100::Mode::Ready: return "READY";
    case lt100::Mode::Motion: return "MOTION";
    case lt100::Mode::Fault: return "FAULT";
    case lt100::Mode::Estop: return "ESTOP";
    default: return "?";
  }
}

void rawSlot(char* out, size_t size, uint8_t index) {
  const lt100::ServoFeedback& fb = core.feedback(index);
  if (fb.online) {
    snprintf(out, size, "%4d", fb.raw);
  } else {
    snprintf(out, size, "----");
  }
}

void drawOled() {
  char l0[26];
  char l1[26];
  char l2[26];
  char j1[8];
  char j2[8];
  char j3[8];

  const uint8_t online = core.onlineMask();
  const uint8_t calibrated = core.calMask();
  if (core.mode() == lt100::Mode::Fault || core.mode() == lt100::Mode::Estop) {
    snprintf(l0, sizeof(l0), "%-5s E%u O%u C%u", modeText(core.mode()),
             static_cast<unsigned>(core.lastError()),
             static_cast<unsigned>(online), static_cast<unsigned>(calibrated));
  } else {
    snprintf(l0, sizeof(l0), "%-5s O%u C%u T%u", modeText(core.mode()),
             static_cast<unsigned>(online),
             static_cast<unsigned>(calibrated),
             static_cast<unsigned>(core.torqueMask()));
  }

  rawSlot(j1, sizeof(j1), 0);
  rawSlot(j2, sizeof(j2), 1);
  rawSlot(j3, sizeof(j3), 2);
  snprintf(l1, sizeof(l1), "J1 %s J2 %s", j1, j2);

  int voltage = 0;
  for (uint8_t i = 0; i < lt100::kJointCount; i++) {
    if (core.feedback(i).online) {
      voltage = core.feedback(i).voltage;
      break;
    }
  }
  snprintf(l2, sizeof(l2), "J3 %s %4.1fV", j3, voltage / 10.0);

  oled.clearBuffer();
  oled.setFont(u8g2_font_5x7_tf);
  oled.drawStr(0, 8, l0);
  oled.drawStr(0, 19, l1);
  oled.drawStr(0, 30, l2);
  oled.sendBuffer();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial1.begin(SERVO_BAUD, SERIAL_8N1, SERVO_RX, SERVO_TX);
  servoBus.pSerial = &Serial1;
  servoBus.IOTimeOut = SERVO_TIMEOUT_MS;

  oled.begin();
  oled.setBusClock(400000);

  delay(300);  // let the 12V servo bus boot before the first read
  core.begin();
  core.handleLine("HELLO", 5);
  core.handleLine("STATE", 5);
  core.handleLine("CAL STATUS", 10);
  drawOled();
}

void loop() {
  lineReader.poll();
  core.tick();

  const uint32_t now = millis();
  if (now - lastOledMs >= OLED_PERIOD_MS) {
    lastOledMs = now;
    drawOled();
  }
}
