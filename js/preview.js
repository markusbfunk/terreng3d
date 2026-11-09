import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WALL } from './mesh.js';

export class Preview {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1f2328);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 50000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-1, 1, 1.3); // lys fra nordvest, som på kart
    this.scene.add(sun);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.fitted = false;
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  // tiles: [{ positions, indices, triCls, offset: [x, y] }]
  setTiles(tiles, colors, wallColor, refit, symColors = {}) {
    for (const m of this.group.children) m.geometry.dispose();
    this.group.clear();
    const box = new THREE.Box3();
    for (const t of tiles) {
      const nT = t.triCls.length;
      const pos = new Float32Array(nT * 9);
      for (let i = 0; i < nT; i++) {
        for (let v = 0; v < 3; v++) {
          const vi = t.indices[i * 3 + v] * 3, o = i * 9 + v * 3;
          pos[o] = t.positions[vi] + t.offset[0];
          pos[o + 1] = t.positions[vi + 1] + t.offset[1];
          pos[o + 2] = t.positions[vi + 2];
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nT * 9), 3));
      g.computeVertexNormals();
      g.computeBoundingBox();
      box.union(g.boundingBox);
      const mesh = new THREE.Mesh(g, this.material);
      mesh.userData.triCls = t.triCls;
      mesh.userData.symKey = t.symKey || null;
      this.group.add(mesh);
    }
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.group.position.set(-c.x, -c.y, 0);
    this.setColors(colors, wallColor, symColors);
    if (refit || !this.fitted) {
      const d = Math.max(size.x, size.y) * 1.25;
      this.camera.position.set(0, -d * 0.95, d * 0.75);
      this.controls.target.set(0, 0, size.z * 0.3);
      this.controls.update();
      this.fitted = true;
    }
    this.render();
  }

  setColors(colors, wallColor, symColors = {}) {
    const cols = colors.map((h) => new THREE.Color(h));
    const wall = new THREE.Color(wallColor).multiplyScalar(0.75);
    for (const m of this.group.children) {
      const arr = m.geometry.attributes.color.array;
      const tc = m.userData.triCls;
      const solid = m.userData.symKey ? new THREE.Color(symColors[m.userData.symKey] || '#888888') : null;
      for (let i = 0; i < tc.length; i++) {
        const col = solid || (tc[i] === WALL ? wall : cols[tc[i]] || wall);
        for (let v = 0; v < 3; v++) {
          const o = i * 9 + v * 3;
          arr[o] = col.r; arr[o + 1] = col.g; arr[o + 2] = col.b;
        }
      }
      m.geometry.attributes.color.needsUpdate = true;
    }
    this.render();
  }
}
