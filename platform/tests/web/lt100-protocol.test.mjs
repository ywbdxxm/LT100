import test from "node:test";
import assert from "node:assert/strict";

import {
  calComplete,
  calDirCommand,
  calMarkCommand,
  calRefCommand,
  endpointPose,
  formatQ,
  parseCalLine,
  parseError,
  parseHello,
  parseLimitsLine,
  parseState,
  poseCommand,
  qToRaw,
  rawToQ,
  safeRange,
  torqueCommand,
} from "../../../web/lt100-protocol.mjs";

const STATE_LINE =
  "STATE seq=42 mode=READY online=7 cal=7 torque=7 err=0 age=12 " +
  "q=20.0,0.0,-10.0 raw=2276,2048,1934 load=100,100,100 cur=20,20,20 " +
  "v=120 t=39,40,38";

test("parses HELLO", () => {
  const hello = parseHello(
    "HELLO protocol=1 fw=0.1.0 cal=1 features=state,stream,motion,cal,limits"
  );
  assert.equal(hello.protocol, 1);
  assert.equal(hello.fw, "0.1.0");
  assert.deepEqual(hello.features, [
    "state",
    "stream",
    "motion",
    "cal",
    "limits",
  ]);
});

test("parses STATE arrays and scalars", () => {
  const state = parseState(STATE_LINE);
  assert.equal(state.mode, "READY");
  assert.equal(state.online, 7);
  assert.equal(state.cal, 7);
  assert.equal(state.torque, 7);
  assert.equal(state.err, 0);
  assert.equal(state.age, 12);
  assert.deepEqual(state.q, [20, 0, -10]);
  assert.deepEqual(state.raw, [2276, 2048, 1934]);
  assert.deepEqual(state.load, [100, 100, 100]);
  assert.deepEqual(state.cur, [20, 20, 20]);
  assert.deepEqual(state.temp, [39, 40, 38]);
  assert.equal(state.v, 120);
});

test("parses ERR and CAL/LIMITS lines", () => {
  const err = parseError("ERR code=10 seq=42 joint=0 msg=outside_safe");
  assert.deepEqual(err, {
    code: 10,
    seq: 42,
    joint: 0,
    msg: "outside_safe",
  });

  const cal = parseCalLine(
    "CAL id=1 ref=1 min_set=1 max_set=1 zero_raw=2048 zero_q=90.0 sign=-1 " +
      "min=1000 max=3000 margin=40 valid=1"
  );
  assert.equal(cal.id, 1);
  assert.equal(cal.zeroQ, 90);
  assert.equal(cal.sign, -1);
  assert.equal(cal.valid, true);

  const limits = parseLimitsLine(
    "LIMITS id=1 min=1000 max=3000 safe=1040..2960 valid=1"
  );
  assert.equal(limits.safeMin, 1040);
  assert.equal(limits.safeMax, 2960);
  assert.equal(limits.valid, true);
});

test("raw/q conversion uses zero_q and direction", () => {
  const cal = {
    valid: true,
    zeroRaw: 2048,
    zeroQ: 90,
    sign: -1,
    minRaw: 1000,
    maxRaw: 3000,
    margin: 40,
  };
  assert.equal(rawToQ(cal, 2048), 90);
  const q = rawToQ(cal, 1024);
  assert.ok(Math.abs(q - 180) < 1e-9);
  assert.equal(qToRaw(cal, q), 1024);
  assert.equal(qToRaw(cal, 90), 2048);
  assert.deepEqual(safeRange(cal), { min: 1040, max: 2960 });
});

test("rejects incomplete calibration for conversion", () => {
  const cal = { valid: false, zeroRaw: 2048, zeroQ: 0, sign: 1 };
  assert.equal(rawToQ(cal, 2048), null);
  assert.equal(qToRaw(cal, 0), null);
  assert.equal(safeRange(cal), null);
  assert.equal(calComplete([cal, cal, cal]), false);
});

test("builds exact protocol commands", () => {
  assert.equal(
    poseCommand(7, [20.04, 0, -10], 10, 20),
    "POSE seq=7 q=20.0,0.0,-10.0 speed=10 acc=20"
  );
  assert.equal(torqueCommand(0, false), "TORQUE all OFF");
  assert.equal(torqueCommand(2, true), "TORQUE 2 ON");
  assert.equal(calRefCommand(1, -90.04), "CAL REF 1 -90.0");
  assert.equal(calDirCommand(2, -1), "CAL DIR 2 -1");
  assert.equal(calMarkCommand(3, "MAX"), "CAL MARK 3 MAX");
  assert.equal(formatQ(-0.04), "0.0");
});

test("endpointPose changes only the selected joint", () => {
  const cal = {
    valid: true,
    zeroRaw: 2048,
    zeroQ: 0,
    sign: 1,
    minRaw: 1000,
    maxRaw: 3000,
    margin: 40,
  };
  const cals = [cal, cal, cal];
  const state = parseState(STATE_LINE);
  const q = endpointPose(state, cals, 2, 1040);
  assert.equal(q.length, 3);
  assert.equal(q[0], 20);
  assert.equal(q[1], 0);
  assert.ok(Math.abs(q[2] - rawToQ(cal, 1040)) < 1e-9);
  assert.equal(endpointPose(state, [null, cal, cal], 0, 1040), null);
});
