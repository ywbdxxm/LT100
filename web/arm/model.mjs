// Parametric LT100 model + ghost + light cone. Built from machine.json sizes,
// not from CAD (hardware/prints are slicer files). Units are millimetres.
//
// Style pass: anodised orange plates with chamfered edges, machined pivot
// bosses, graphite servo housings with silver hubs, a double-wall spun shade
// and a warm diffuser. Everything is still driven only by machine.json.
import * as THREE from "three";
import { fk } from "./kinematics.mjs";

const ORANGE = 0xee7214;
const ORANGE_DARK = 0xc4550a;
const GRAPHITE = 0x232327;
const BASE_BLACK = 0x141312;
const SILVER = 0xdfe4ea;
const HUB = 0x3a3b40;
const GHOST = 0x8fd3ff;
const WARM = 0xfff1dd;

const PICK_RADIUS = 70;
const RING_RADIUS = 24;
const RING_TUBE = 1.8;
const RING_Z = 13;
const RING_IDLE = 0x626c78;

const deg = (value) => (value * Math.PI) / 180;

// Lathe/axis helpers ------------------------------------------------------

function roundedRectShape(width, height, radius) {
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.min(radius, width / 2 - 0.1, height / 2 - 0.1);
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

function roundedPlate(width, height, depth, radius = 6, bevel = 1.5) {
  const geometry = new THREE.ExtrudeGeometry(roundedRectShape(width, height, radius), {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 12,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

// Extruded arm plate: rounded ends, a machined slot, generous chamfer.
function linkGeometry(length, width, thickness) {
  const half = width / 2;
  const r = half - 0.4;
  const shape = new THREE.Shape();
  shape.moveTo(r, -half);
  shape.lineTo(length - r, -half);
  shape.quadraticCurveTo(length, -half, length, -half + r);
  shape.lineTo(length, half - r);
  shape.quadraticCurveTo(length, half, length - r, half);
  shape.lineTo(r, half);
  shape.quadraticCurveTo(0, half, 0, half - r);
  shape.lineTo(0, -half + r);
  shape.quadraticCurveTo(0, -half, r, -half);

  const hole = new THREE.Path();
  hole.absarc(length * 0.5, 0, 3.6, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.9,
    bevelSize: 0.9,
    bevelSegments: 2,
    curveSegments: 20,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function screw(materials, radius = 2.2, depth = 1.1) {
  const group = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.94, depth, 8),
    materials.silver
  );
  head.rotation.x = Math.PI / 2;
  const socket = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, depth + 0.5, 6),
    materials.hub
  );
  socket.rotation.x = Math.PI / 2;
  group.add(head, socket);
  return group;
}

function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 6, 128, 128, 126);
  gradient.addColorStop(0, "#fffaf0");
  gradient.addColorStop(0.42, "#ffe6c0");
  gradient.addColorStop(0.78, "#f3b878");
  gradient.addColorStop(0.94, "#dd9048");
  gradient.addColorStop(1, "#c97834");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function materialsFor(ghost) {
  if (ghost) {
    const keys = [
      "orange",
      "darkOrange",
      "black",
      "base",
      "silver",
      "hub",
      "shade",
      "liner",
      "diffuser",
      "led",
      "accent",
      "cable",
      "servo",
      "horn",
      "plate",
      "inner",
    ];
    const map = {};
    for (const key of keys) map[key] = ghostMaterial();
    return map;
  }
  return {
    orange: new THREE.MeshPhysicalMaterial({
      color: ORANGE,
      metalness: 0.42,
      roughness: 0.36,
      clearcoat: 0.55,
      clearcoatRoughness: 0.38,
      envMapIntensity: 0.9,
    }),
    darkOrange: new THREE.MeshPhysicalMaterial({
      color: ORANGE_DARK,
      metalness: 0.55,
      roughness: 0.4,
      clearcoat: 0.3,
      envMapIntensity: 0.8,
    }),
    black: new THREE.MeshPhysicalMaterial({
      color: GRAPHITE,
      metalness: 0.6,
      roughness: 0.42,
      clearcoat: 0.25,
      clearcoatRoughness: 0.5,
      envMapIntensity: 0.7,
    }),
    base: new THREE.MeshPhysicalMaterial({
      color: 0x1b1a18,
      metalness: 0.2,
      roughness: 0.55,
      clearcoat: 0.18,
      clearcoatRoughness: 0.6,
      envMapIntensity: 0.4,
    }),
    inner: new THREE.MeshStandardMaterial({
      color: 0xd9691f,
      emissive: 0x91400c,
      emissiveIntensity: 0.85,
      metalness: 0.1,
      roughness: 0.72,
    }),
    silver: new THREE.MeshPhysicalMaterial({
      color: SILVER,
      metalness: 1,
      roughness: 0.2,
      envMapIntensity: 1.15,
    }),
    plate: new THREE.MeshStandardMaterial({
      color: 0x2b2b2c,
      metalness: 0.3,
      roughness: 0.5,
      envMapIntensity: 0.5,
    }),
    servo: new THREE.MeshStandardMaterial({
      color: 0x191a1c,
      metalness: 0.32,
      roughness: 0.56,
      envMapIntensity: 0.5,
    }),
    horn: new THREE.MeshStandardMaterial({
      color: 0xc7ccd4,
      metalness: 0.95,
      roughness: 0.3,
      envMapIntensity: 1.1,
    }),
    hub: new THREE.MeshStandardMaterial({
      color: HUB,
      metalness: 0.85,
      roughness: 0.32,
      envMapIntensity: 0.8,
    }),
    shade: new THREE.MeshPhysicalMaterial({
      color: ORANGE,
      metalness: 0.08,
      roughness: 0.62,
      clearcoat: 0.12,
      clearcoatRoughness: 0.6,
      side: THREE.DoubleSide,
      envMapIntensity: 0.7,
    }),
    liner: new THREE.MeshStandardMaterial({
      color: 0xe8d7c1,
      roughness: 0.78,
      metalness: 0.02,
      side: THREE.DoubleSide,
      emissive: 0xffb877,
      emissiveIntensity: 0.07,
    }),
    diffuser: (() => {
      const map = glowTexture();
      return new THREE.MeshStandardMaterial({
        map,
        emissiveMap: map,
        color: 0xfff4e2,
        emissive: 0xffc98d,
        emissiveIntensity: 0.55,
        roughness: 0.55,
        metalness: 0,
      });
    })(),
    led: new THREE.MeshStandardMaterial({
      color: 0xfff0d0,
      emissive: 0xffbe76,
      emissiveIntensity: 1.1,
      roughness: 0.4,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: 0xffb066,
      emissive: 0xff8f36,
      emissiveIntensity: 0.55,
      roughness: 0.5,
      metalness: 0,
    }),
    cable: new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.85, metalness: 0.1 }),
  };
}

function ghostMaterial() {
  return new THREE.MeshBasicMaterial({
    color: GHOST,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  });
}

// Parts -------------------------------------------------------------------

function buildBase(materials, machine) {
  const group = new THREE.Group();

  // Printed drum (Ø136 x 50) with a soft bottom fillet, like the photo.
  const drumProfile = [
    [0, 0],
    [57.5, 0],
    [62.6, 1.2],
    [65.6, 3.4],
    [67.2, 8],
    [68, 15],
    [68, 49],
    [67.2, 52.4],
    [65, 54.6],
    [61, 55.8],
    [54, 56.2],
    [0, 56.2],
  ].map(([radius, height]) => new THREE.Vector2(radius, height));
  const drum = new THREE.Mesh(new THREE.LatheGeometry(drumProfile, 96), materials.base);
  drum.castShadow = drum.receiveShadow = true;
  group.add(drum);

  // Bolted top plate.
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(52, 53, 4.4, 80), materials.plate);
  plate.position.y = 58.4;
  plate.castShadow = plate.receiveShadow = true;
  group.add(plate);

  const plateEdge = new THREE.Mesh(new THREE.TorusGeometry(52.2, 0.7, 8, 80), materials.hub);
  plateEdge.rotation.x = Math.PI / 2;
  plateEdge.position.y = 60.5;
  group.add(plateEdge);

  for (let i = 0; i < 4; i += 1) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    const head = screw(materials, 3.1, 1.6);
    head.rotation.x = 0;
    head.position.set(Math.cos(angle) * 40, 61.4, Math.sin(angle) * 40);
    group.add(head);
  }

  // Orange knob (top plate, front-right) — the base's only control.
  const knobSeat = new THREE.Mesh(new THREE.CylinderGeometry(10, 10.6, 2.4, 40), materials.hub);
  knobSeat.position.set(33, 61.6, 33);
  group.add(knobSeat);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(7.4, 7.8, 6.4, 40), materials.darkOrange);
  knob.position.set(33, 65.8, 33);
  knob.castShadow = true;
  group.add(knob);
  const knobCap = new THREE.Mesh(new THREE.SphereGeometry(7, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), materials.darkOrange);
  knobCap.position.set(33, 69, 33);
  knobCap.scale.y = 0.55;
  group.add(knobCap);

  // Short column + shoulder bracket.
  const columnHeight = Math.max(4, machine.base.shoulder_height - 60 - 14);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(15, 15.6, columnHeight, 40), materials.base);
  column.position.y = 60 + columnHeight / 2;
  column.castShadow = true;
  group.add(column);

  const bracket = new THREE.Mesh(roundedPlate(34, 26, 26, 5, 1.2), materials.servo);
  bracket.position.y = 60 + columnHeight + 7;
  bracket.castShadow = bracket.receiveShadow = true;
  group.add(bracket);

  // Cable gland + lead lying on the floor.
  const grommet = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 3, 20), materials.hub);
  grommet.rotation.z = Math.PI / 2;
  grommet.position.set(-66, 22, 8);
  group.add(grommet);

  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-68, 22, 9),
    new THREE.Vector3(-96, 14, 26),
    new THREE.Vector3(-132, 5.4, 52),
    new THREE.Vector3(-166, 2.6, 84),
  ]);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 2.6, 10, false), materials.cable);
  cable.castShadow = true;
  group.add(cable);

  return group;
}

// ST3215 servo nested inside the printed U-channel, bushings on both walls.
function jointHousing(materials, alongX, acrossY, throughZ) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(alongX, acrossY, throughZ), materials.servo);
  body.castShadow = body.receiveShadow = true;
  group.add(body);

  // Moulded parting lines across the case.
  for (const z of [-0.28, 0.28]) {
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(alongX + 0.6, acrossY + 0.6, 1.1),
      materials.servo
    );
    seam.position.z = z * throughZ;
    group.add(seam);
  }

  // Brass-coloured lead exit on the back of the case.
  const nub = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 4), materials.hub);
  nub.position.set(-alongX * 0.18, 0, -throughZ / 2 - 1.4);
  group.add(nub);

  // Output shaft + bearing bushings through both side walls.
  for (const side of [1, -1]) {
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 3, 24), materials.hub);
    stub.position.y = side * (acrossY / 2 + 1.5);
    stub.castShadow = true;
    group.add(stub);

    const bushing = new THREE.Mesh(new THREE.CylinderGeometry(9.4, 9.4, 3.4, 36), materials.horn);
    bushing.position.y = side * (acrossY / 2 + 4.4);
    bushing.castShadow = true;
    group.add(bushing);

    const lip = new THREE.Mesh(new THREE.TorusGeometry(9.5, 0.8, 8, 36), materials.silver);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = side * (acrossY / 2 + 6.1);
    group.add(lip);

    const cap = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 1.8, 20), materials.hub);
    cap.position.y = side * (acrossY / 2 + 6.3);
    group.add(cap);

    // Four little screws around each bushing, sitting proud of the wall.
    for (let i = 0; i < 4; i += 1) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      const head = screw(materials, 1.8, 1.0);
      head.rotation.z = Math.PI / 2;
      head.position.set(
        Math.cos(angle) * 12.6,
        side * (acrossY / 2 + 4.2),
        Math.sin(angle) * 12.6
      );
      group.add(head);
    }
  }

  return group;
}

// Printed U-channel link: two side walls + back web, open toward the viewer.
function armLink(materials, length, width = 42, wall = 3.8, depth = 19) {
  const group = new THREE.Group();
  const half = width / 2;

  // Everything is laid out around a shared origin, then shifted so the link
  // runs from the joint at x=0 to x=length.
  const parts = new THREE.Group();
  parts.position.x = length / 2;
  group.add(parts);

  for (const side of [1, -1]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(length, wall, depth), materials.orange);
    plate.position.y = side * (half - wall / 2);
    plate.castShadow = plate.receiveShadow = true;
    parts.add(plate);

    // Rounded outer edges of the printed channel.
    for (const x of [-length / 2, length / 2]) {
      const bead = new THREE.Mesh(new THREE.CylinderGeometry(wall / 2, wall / 2, depth, 12), materials.orange);
      bead.rotation.x = Math.PI / 2;
      bead.position.set(x, side * (half - wall / 2), 0);
      parts.add(bead);
    }
  }

  const web = new THREE.Mesh(new THREE.BoxGeometry(length - 2, width - wall * 2, wall), materials.inner);
  web.position.z = -(depth / 2 - wall / 2);
  web.castShadow = web.receiveShadow = true;
  parts.add(web);

  // Faint machined strip down the channel floor.
  const strip = new THREE.Mesh(new THREE.BoxGeometry(length * 0.66, 1.4, 0.8), materials.darkOrange);
  strip.position.set(0, 0, -(depth / 2 - wall - 0.5));
  parts.add(strip);

  // Servo lead lying along the channel floor.
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-length / 2 + 6, width * 0.22, -depth / 2 + wall + 3.4),
    new THREE.Vector3(-length * 0.17, width * 0.28, -depth / 2 + wall + 4.4),
    new THREE.Vector3(length * 0.17, width * 0.28, -depth / 2 + wall + 4.4),
    new THREE.Vector3(length / 2 - 6, width * 0.22, -depth / 2 + wall + 3.4),
  ]);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 1.9, 10, false), materials.cable);
  cable.castShadow = true;
  parts.add(cable);

  return group;
}

// Thin funnel shade (Ø100 mouth, 65 deep) with a bolted back plate.
function buildShade(materials, shadeRadius, shadeDepth) {
  const group = new THREE.Group();
  const R = shadeRadius;
  const D = shadeDepth;
  const throat = R * 0.5;

  const profile = [
    [throat, 0],
    [R * 0.68, D * 0.28],
    [R * 0.86, D * 0.58],
    [R * 0.97, D * 0.86],
    [R, D],
  ].map(([radius, height]) => new THREE.Vector2(radius, height));
  const shell = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), materials.shade);
  shell.castShadow = shell.receiveShadow = true;
  group.add(shell);

  const lip = new THREE.Mesh(new THREE.TorusGeometry(R - 0.35, 1.15, 10, 96), materials.shade);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = D;
  group.add(lip);

  const back = new THREE.Mesh(new THREE.CircleGeometry(throat, 64), materials.inner);
  back.rotation.x = -Math.PI / 2;
  back.position.y = -0.4;
  back.castShadow = true;
  group.add(back);

  const pad = new THREE.Mesh(new THREE.BoxGeometry(26, 1.8, 26), materials.inner);
  pad.position.y = 0.9;
  pad.castShadow = pad.receiveShadow = true;
  group.add(pad);

  for (let i = 0; i < 4; i += 1) {
    const sx = (i % 2 === 0 ? -1 : 1) * 7;
    const sz = (i < 2 ? -1 : 1) * 7;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.1, 12), materials.silver);
    head.position.set(sx, 2.2, sz);
    group.add(head);
    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.4, 6), materials.hub);
    socket.position.set(sx, 2.8, sz);
    group.add(socket);
  }

  return group;
}

function build(machine, materials, withBase) {
  const root = new THREE.Group();
  root.rotation.y = deg(machine.base.yaw_deg ?? 0);
  const shoulderHeight = machine.base.shoulder_height;
  const { l1, l2, l3 } = machine.links;
  const shadeDepth = machine.head.shade_depth ?? 65;
  const shadeRadius = machine.head.shade_radius ?? 50;

  if (withBase) {
    root.add(buildBase(materials, machine));
  }


  const shoulder = new THREE.Group();
  shoulder.position.y = shoulderHeight;
  root.add(shoulder);
  const shoulderServo = jointHousing(materials, 46, 30, 18);
  shoulder.add(shoulderServo);
  shoulder.add(armLink(materials, l1));

  const elbow = new THREE.Group();
  elbow.position.x = l1;
  shoulder.add(elbow);
  const elbowServo = jointHousing(materials, 46, 30, 18);
  elbow.add(elbowServo);
  elbow.add(armLink(materials, l2));

  const wrist = new THREE.Group();
  wrist.position.x = l2;
  elbow.add(wrist);
  // Black clamp printed around the channel end, holding the wrist servo.
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(17, 46, 27), materials.servo);
  clamp.position.x = -16;
  clamp.castShadow = clamp.receiveShadow = true;
  wrist.add(clamp);
  for (const sy of [-1, 1]) {
    for (const x of [-23, -9]) {
      const head = screw(materials, 2.1, 1.1);
      head.rotation.z = Math.PI / 2;
      head.position.set(x, sy * 23.6, 0);
      wrist.add(head);
    }
  }

  // Wrist servo lying flat, output horn facing the viewer.
  const wristServo = new THREE.Mesh(new THREE.BoxGeometry(40, 28, 18), materials.servo);
  wristServo.position.set(6, 0, -1);
  wristServo.castShadow = wristServo.receiveShadow = true;
  wrist.add(wristServo);
  for (const z of [-7.6, -5.4]) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(41, 29, 1), materials.servo);
    rib.position.set(6, 0, z);
    wrist.add(rib);
  }

  // Silver servo horn: plain disc, small cross hole, four threaded bosses.
  const horn = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 2.4, 44), materials.horn);
  horn.rotation.x = Math.PI / 2;
  horn.position.set(6, 0, 8.2);
  wrist.add(horn);
  const hornLip = new THREE.Mesh(new THREE.TorusGeometry(15.05, 0.55, 8, 44), materials.silver);
  hornLip.position.set(6, 0, 9.3);
  wrist.add(hornLip);
  const hornHole = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 1.2, 18), materials.hub);
  hornHole.rotation.x = Math.PI / 2;
  hornHole.position.set(6, 0, 9.5);
  wrist.add(hornHole);

  // Bridge arm: bolted to the horn at one end, square flange on the shade's
  // bottom circular face at the other end.
  // L-shaped head bracket: one flange lies on the servo horn (normal = wrist
  // axis), then an arm, then a square flange bolted to the shade's bottom
  // circular face (normal = shade axis). The two screw planes are square to
  // each other, which is what the photos show.
  const backX = l3 - shadeDepth / 2 + 1.6;
  const seatX = backX - 2.4;
  const bridgeLength = Math.max(24, seatX - 6);
  const bridge = new THREE.Mesh(roundedPlate(bridgeLength, 26, 5, 9, 1), materials.orange);
  bridge.position.set(6 + bridgeLength / 2, 0, 11.9);
  bridge.castShadow = bridge.receiveShadow = true;
  wrist.add(bridge);

  // Round boss coaxial with the shade, bolted onto its bottom face.
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 5.2, 40), materials.orange);
  seat.rotation.z = Math.PI / 2;
  seat.position.set(seatX - 1.6, 0, 11.9);
  seat.castShadow = seat.receiveShadow = true;
  wrist.add(seat);

  for (let i = 0; i < 4; i += 1) {
    const sy = (i % 2 === 0 ? -1 : 1) * 9.4;
    const sz = (i < 2 ? -1 : 1) * 9.4;
    const head = screw(materials, 1.9, 1.1);
    head.rotation.z = -Math.PI / 2;
    head.position.set(seatX - 4.2, sy, 11.9 + sz);
    wrist.add(head);
  }

  for (let i = 0; i < 4; i += 1) {
    const angle = (i * Math.PI) / 2;
    const head = screw(materials, 2.1, 1.15);
    head.rotation.x = Math.PI / 2;
    head.position.set(6 + Math.cos(angle) * 9.6, Math.sin(angle) * 9.6, 15.1);
    wrist.add(head);
  }

  const shadeGroup = new THREE.Group();
  shadeGroup.position.set(l3, 0, 11.9);
  shadeGroup.rotation.z = deg(machine.head.mount_deg);
  wrist.add(shadeGroup);

  const shadeBody = new THREE.Group();
  shadeBody.rotation.z = -Math.PI / 2;
  shadeBody.position.x = -shadeDepth / 2;
  shadeGroup.add(shadeBody);
  shadeBody.add(buildShade(materials, shadeRadius, shadeDepth));

  let pickProxy = null;
  let marker = null;
  const rings = [];
  if (withBase) {
    pickProxy = new THREE.Mesh(
      new THREE.SphereGeometry(PICK_RADIUS, 16, 12),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      })
    );
    shadeGroup.add(pickProxy);

    marker = new THREE.Mesh(
      new THREE.TorusGeometry(18, 2.5, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xff4a3d })
    );
    marker.visible = false;
    marker.renderOrder = 3;
    root.add(marker);

    const ringZ = 15;
    for (const group of [shoulder, elbow, wrist]) {
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, ringZ, 16), materials.hub);
      pin.rotation.x = Math.PI / 2;
      pin.position.z = ringZ / 2;
      group.add(pin);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(RING_RADIUS + 2, 0.95, 10, 56),
        new THREE.MeshStandardMaterial({
          color: RING_IDLE,
          metalness: 0.7,
          roughness: 0.42,
          envMapIntensity: 0.8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );
      ring.position.z = ringZ;
      ring.renderOrder = 4;
      group.add(ring);
      rings.push(ring);
    }
  }

  return { root, shoulder, elbow, wrist, shadeGroup, pickProxy, marker, rings };
}

function spotTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 2, 128, 128, 126);
  gradient.addColorStop(0, "rgba(255,224,178,0.95)");
  gradient.addColorStop(0.35, "rgba(255,196,132,0.42)");
  gradient.addColorStop(0.75, "rgba(255,180,100,0.12)");
  gradient.addColorStop(1, "rgba(255,180,100,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function beamMaterial(opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffc98d) },
      uOpacity: { value: opacity },
    },
    vertexShader: [
      "varying vec3 vN;",
      "varying vec3 vV;",
      "varying float vH;",
      "void main() {",
      "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
      "  vN = normalize(normalMatrix * normal);",
      "  vV = normalize(-mv.xyz);",
      "  vH = uv.y;",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform vec3 uColor;",
      "uniform float uOpacity;",
      "varying vec3 vN;",
      "varying vec3 vV;",
      "varying float vH;",
      "void main() {",
      "  float edge = 1.0 - abs(dot(normalize(vN), normalize(vV)));",
      "  float a = mix(0.22, 1.0, pow(edge, 1.7));",
      "  a *= smoothstep(0.0, 0.12, vH);",
      "  a *= 1.0 - smoothstep(0.88, 1.0, vH) * 0.9;",
      "  gl_FragColor = vec4(uColor, uOpacity * a);",
      "}",
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function createBeam() {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 48, 1, true), beamMaterial(0.12));
  cone.renderOrder = 2;

  const spot = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({
      map: spotTexture(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  spot.rotation.x = -Math.PI / 2;

  const light = new THREE.SpotLight(0xffc98d, 1.5, 0, 0.22, 0.72, 0);
  const target = new THREE.Object3D();
  light.target = target;
  return { cone, spot, light, target };
}

function updateBeam(beam, machine, qModel) {
  const pose = fk(machine, qModel);
  const sin = Math.sin(deg(pose.psi));
  const cos = Math.cos(deg(pose.psi));
  const BEAM_ANGLE = 0.22;
  const visible = sin < -0.18 && pose.lamp.y > 0;
  beam.cone.visible = visible;
  beam.spot.visible = visible;
  beam.light.visible = visible;
  if (!visible) return;

  const length = pose.lamp.y / -sin;
  const radius = Math.tan(BEAM_ANGLE) * length;
  const dir = new THREE.Vector3(cos, sin, 0);

  beam.cone.position.set(
    pose.lamp.x + (cos * length) / 2,
    pose.lamp.y + (sin * length) / 2,
    0
  );
  beam.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
  beam.cone.scale.set(radius, length, radius);

  const spotX = pose.lamp.x + cos * length;
  beam.spot.position.set(spotX, 0.8, 0);
  beam.spot.scale.setScalar(radius * 1.2);

  beam.light.position.set(pose.lamp.x, pose.lamp.y, 0);
  beam.light.angle = BEAM_ANGLE;
  beam.target.position.set(spotX, 0, 0);
}

export function createRig(machine, options = {}) {
  const ghost = Boolean(options.ghost);
  const materials = materialsFor(ghost);
  const body = build(machine, materials, !ghost);

  let beam = null;
  if (options.beam) {
    beam = createBeam();
    body.root.add(beam.cone, beam.spot, beam.light, beam.target);
  }

  let pose = machine.joints.map((joint) => joint.model_ref_q);
  let activeRing = null;
  const project = (point, camera, width, height) => {
    camera.updateMatrixWorld();
    const v = new THREE.Vector3(point.x, point.y, point.z ?? 0).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * width,
      y: (-v.y * 0.5 + 0.5) * height,
    };
  };
  const getJointRings = () => {
    body.root.updateMatrixWorld(true);
    return body.rings.map((ring, index) => {
      const center = new THREE.Vector3();
      ring.getWorldPosition(center);
      return {
        index,
        center: { x: center.x, y: center.y, z: center.z },
        radius: RING_RADIUS,
      };
    });
  };
  const setPose = (qModel) => {
    pose = [...qModel];
    body.shoulder.rotation.z = deg(qModel[0]);
    body.elbow.rotation.z = deg(qModel[1]);
    body.wrist.rotation.z = deg(qModel[2]);
    if (beam) updateBeam(beam, machine, qModel);
  };

  const getLampWorld = () => {
    body.root.updateMatrixWorld(true);
    return body.shadeGroup.getWorldPosition(new THREE.Vector3());
  };

  return {
    group: body.root,
    setPose,
    getPose: () => [...pose],
    getLampWorld,
    getPickSphere: () => {
      body.root.updateMatrixWorld(true);
      const center = new THREE.Vector3();
      body.pickProxy.getWorldPosition(center);
      return {
        center: { x: center.x, y: center.y, z: center.z },
        radius: PICK_RADIUS,
      };
    },
    getLampScreen: (camera, width, height) =>
      project(getLampWorld(), camera, width, height),
    getJointRings,
    getRingScreens: (camera, width, height) =>
      getJointRings().map((ring) => ({
        index: ring.index,
        ...project(ring.center, camera, width, height),
      })),
    getPlaneScreen: (point, camera, width, height) =>
      project({ x: point.x, y: point.y, z: 0 }, camera, width, height),
    setRingActive: (index) => {
      activeRing = index ?? null;
      body.rings.forEach((ring, i) => {
        const on = i === index;
        ring.material.color.set(on ? ORANGE : RING_IDLE);
        ring.material.opacity = on ? 0.95 : 0;
      });
    },
    getActiveRing: () => activeRing,
    setMarker: (point) => {
      if (!body.marker) return;
      body.marker.visible = Boolean(point);
      if (point) body.marker.position.set(point.x, point.y, 1.5);
    },
    isMarkerVisible: () => Boolean(body.marker?.visible),
  };
}
