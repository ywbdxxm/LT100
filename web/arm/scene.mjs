// Three.js stage: renderer, camera, orbit controls, lights, table.
import * as THREE from "three";
import { OrbitControls } from "../vendor/three/OrbitControls.js";
import { RoomEnvironment } from "../vendor/three/RoomEnvironment.js";

function backdropTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, "#2a1a0d");
  gradient.addColorStop(0.42, "#150d07");
  gradient.addColorStop(0.72, "#040302");
  gradient.addColorStop(1, "#000000");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 32, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function shadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 8, 128, 128, 128);
  gradient.addColorStop(0, "rgba(0,0,0,0.72)");
  gradient.addColorStop(0.42, "rgba(0,0,0,0.4)");
  gradient.addColorStop(0.75, "rgba(0,0,0,0.12)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

export function createScene(canvas, machine) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  // Flat, very dark stage colour shared with the fog: the table then fades
  // into the same tone at the horizon, so the plane edge never shows.
  scene.background = new THREE.Color(0x161009);
  scene.fog = new THREE.Fog(0x161009, 1500, 3000);

  const camera = new THREE.PerspectiveCamera(33, 1, 5, 6000);
  camera.position.set(600, 395, 800);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 245, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 350;
  controls.maxDistance = 2400;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();

  scene.add(new THREE.HemisphereLight(0x9a8c7c, 0x241a12, 0.5));

  const key = new THREE.DirectionalLight(0xffd9b2, 2.6);
  key.position.set(520, 940, 720);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 100;
  key.shadow.camera.far = 2600;
  key.shadow.camera.left = -750;
  key.shadow.camera.right = 750;
  key.shadow.camera.top = 900;
  key.shadow.camera.bottom = -200;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.6;
  scene.add(key);

  // Soft fill from the camera side so the orange anodising reads on the
  // shadowed faces without flattening the key light.
  const fill = new THREE.DirectionalLight(0xffe7cf, 0.7);
  fill.position.set(-260, 320, 980);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xb9c4d0, 0.2);
  rim.position.set(-700, 300, -820);
  scene.add(rim);

  // Warm bounce off the table so the underside of the shade and links read.
  const bounce = new THREE.DirectionalLight(0xffc79a, 0.22);
  bounce.position.set(120, -260, 420);
  scene.add(bounce);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envTarget.texture;

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(12000, 12000),
    new THREE.MeshStandardMaterial({ color: 0x1f1812, roughness: 0.9, metalness: 0.05 })
  );
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);

  const contact = new THREE.Mesh(
    new THREE.CircleGeometry(machine.base.radius * 2.1, 64),
    new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.4;
  scene.add(contact);

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const render = () => {
    controls.update();
    renderer.render(scene, camera);
  };

  const dispose = () => {
    observer.disconnect();
    controls.dispose();
    envTarget.dispose();
    pmrem.dispose();
    renderer.dispose();
  };

  return { scene, camera, controls, renderer, render, resize, dispose };
}
