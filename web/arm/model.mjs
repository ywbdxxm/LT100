// Parametric LT100 model + ghost + light cone. Built from machine.json sizes,
// not from CAD (hardware/prints are slicer files). Units are millimetres.
import * as THREE from "three";
import { fk } from "./kinematics.mjs";

const ORANGE = 0xef7518;
const BLACK = 0x1c1c1f;
const SILVER = 0xc3c8cf;
const GHOST = 0x8fd3ff;
const PICK_RADIUS = 70;

const deg = (value) => (value * Math.PI) / 180;

function linkGeometry(length, width, thickness) {
  const half = width / 2;
  const r = Math.min(9, half - 2);
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

  const slot = new THREE.Path();
  const cx = length / 2;
  const sl = length * 0.3;
  const sw = Math.max(3, width * 0.16);
  slot.moveTo(cx - sl, -sw);
  slot.lineTo(cx + sl, -sw);
  slot.absarc(cx + sl, 0, sw, -Math.PI / 2, Math.PI / 2, false);
  slot.lineTo(cx - sl, sw);
  slot.absarc(cx - sl, 0, sw, Math.PI / 2, Math.PI * 1.5, false);
  shape.holes.push(slot);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 1.2,
    bevelSize: 1.2,
    bevelSegments: 2,
    curveSegments: 12,
  });
  geometry.translate(0, 0, -thickness / 2);
  return geometry;
}

function shadeProfile() {
  const points = [
    [6, 0],
    [20, 16],
    [36, 38],
    [47, 55],
    [50, 65],
  ];
  return points.map(([radius, height]) => new THREE.Vector2(radius, height));
}

function solidMaterials() {
  return {
    orange: new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.52, metalness: 0.05 }),
    black: new THREE.MeshStandardMaterial({
      color: BLACK,
      roughness: 0.62,
      metalness: 0.02,
      envMapIntensity: 0.3,
    }),
    base: new THREE.MeshStandardMaterial({
      color: 0x191816,
      roughness: 0.8,
      metalness: 0,
      envMapIntensity: 0,
    }),
    silver: new THREE.MeshStandardMaterial({ color: SILVER, roughness: 0.28, metalness: 0.9 }),
    shade: new THREE.MeshStandardMaterial({
      color: ORANGE,
      roughness: 0.5,
      metalness: 0.04,
      side: THREE.DoubleSide,
    }),
    led: new THREE.MeshStandardMaterial({
      color: 0xffe6c4,
      emissive: 0xffc27a,
      emissiveIntensity: 1.1,
      roughness: 0.4,
    }),
  };
}

function ghostMaterial() {
  return new THREE.MeshBasicMaterial({
    color: GHOST,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
}

function servo(materials, width, height, depth) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials.black);
  body.castShadow = true;
  group.add(body);
  const horn = new THREE.Mesh(
    new THREE.CylinderGeometry(9, 9, 3, 24),
    materials.silver
  );
  horn.rotation.x = Math.PI / 2;
  horn.position.z = depth / 2 + 1.5;
  group.add(horn);
  return group;
}

function spotTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 126);
  gradient.addColorStop(0, "rgba(255,214,160,0.85)");
  gradient.addColorStop(0.45, "rgba(255,190,120,0.35)");
  gradient.addColorStop(1, "rgba(255,180,100,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBeam() {
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(1, 1, 32, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffc27a,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
  );
  cone.renderOrder = 2;

  const spot = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({
      map: spotTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  spot.rotation.x = -Math.PI / 2;

  const light = new THREE.SpotLight(0xffc98d, 1.4, 0, 0.22, 0.7, 0);
  const target = new THREE.Object3D();
  light.target = target;
  return { cone, spot, light, target };
}

function build(machine, materials, withBase) {
  const root = new THREE.Group();
  root.rotation.y = deg(machine.base.yaw_deg ?? 0);
  const shoulderHeight = machine.base.shoulder_height;
  const { l1, l2, l3 } = machine.links;
  const shadeDepth = machine.head.shade_depth ?? 65;
  const shadeRadius = machine.head.shade_radius ?? 50;

  if (withBase) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(85, 88, 55, 48), materials.base);
    base.position.y = 27.5;
    base.castShadow = base.receiveShadow = true;
    root.add(base);

    const plate = new THREE.Mesh(new THREE.CylinderGeometry(82, 82, 8, 48), materials.base);
    plate.position.y = 59;
    plate.castShadow = plate.receiveShadow = true;
    root.add(plate);

    const columnHeight = Math.max(4, shoulderHeight - 63);
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(26, 30, columnHeight, 24),
      materials.base
    );
    column.position.y = 63 + columnHeight / 2;
    column.castShadow = true;
    root.add(column);

    const crank = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 16, 12), materials.silver);
    crank.position.set(56, 64, 6);
    crank.castShadow = true;
    root.add(crank);

    const knob = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 12), materials.orange);
    knob.position.set(56, 73, 6);
    knob.castShadow = true;
    root.add(knob);
  }

  const shoulder = new THREE.Group();
  shoulder.position.y = shoulderHeight;
  root.add(shoulder);
  shoulder.add(servo(materials, 42, 32, 24));

  const upper = new THREE.Mesh(linkGeometry(l1, 28, 10), materials.orange);
  upper.castShadow = true;
  upper.receiveShadow = true;
  shoulder.add(upper);

  const elbow = new THREE.Group();
  elbow.position.x = l1;
  shoulder.add(elbow);
  elbow.add(servo(materials, 42, 32, 24));

  const fore = new THREE.Mesh(linkGeometry(l2, 28, 10), materials.orange);
  fore.castShadow = true;
  fore.receiveShadow = true;
  elbow.add(fore);

  const wrist = new THREE.Group();
  wrist.position.x = l2;
  elbow.add(wrist);
  wrist.add(servo(materials, 36, 28, 22));

  const bracketLength = Math.max(10, l3 - shadeDepth / 2);
  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(bracketLength, 12, 9),
    materials.black
  );
  bracket.position.x = bracketLength / 2;
  bracket.castShadow = true;
  wrist.add(bracket);

  const shadeGroup = new THREE.Group();
  shadeGroup.position.x = l3;
  shadeGroup.rotation.z = deg(machine.head.mount_deg);
  wrist.add(shadeGroup);

  const shade = new THREE.Mesh(new THREE.LatheGeometry(shadeProfile(), 48), materials.shade);
  shade.rotation.z = -Math.PI / 2;
  shade.position.x = -shadeDepth / 2;
  shade.castShadow = true;
  shadeGroup.add(shade);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(shadeRadius * 0.78, 2.4, 10, 48),
    materials.led
  );
  ring.rotation.y = Math.PI / 2;
  ring.position.x = shadeDepth / 2 - 10;
  shadeGroup.add(ring);

  let pickProxy = null;
  let marker = null;
  if (withBase) {
    // Invisible pick sphere; getPickSphere() exposes its center/radius.
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
  }

  return { root, shoulder, elbow, wrist, shadeGroup, pickProxy, marker };
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
  const materials = ghost
    ? {
        orange: ghostMaterial(),
        black: ghostMaterial(),
        silver: ghostMaterial(),
        shade: ghostMaterial(),
        led: ghostMaterial(),
      }
    : solidMaterials();
  const body = build(machine, materials, !ghost);

  let beam = null;
  if (options.beam) {
    beam = createBeam();
    body.root.add(beam.cone, beam.spot, beam.light, beam.target);
  }

  let pose = machine.joints.map((joint) => joint.model_ref_q);
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
    getLampScreen: (camera, width, height) => {
      camera.updateMatrixWorld();
      const point = getLampWorld().project(camera);
      return {
        x: (point.x * 0.5 + 0.5) * width,
        y: (-point.y * 0.5 + 0.5) * height,
      };
    },
    setMarker: (point) => {
      if (!body.marker) return;
      body.marker.visible = Boolean(point);
      if (point) body.marker.position.set(point.x, point.y, 1.5);
    },
    isMarkerVisible: () => Boolean(body.marker?.visible),
  };
}
