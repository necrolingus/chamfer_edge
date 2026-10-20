import * as THREE from 'three';
import { initCSGEngine } from './chamferEngine.js';

/**
 * Converts a Manifold object into a centered, flat-shaded THREE.BufferGeometry.
 */
function manifoldToThreeGeometry(manifoldObj) {
  const outMesh = manifoldObj.getMesh();
  const outVerts = outMesh.vertProperties;
  const outTris = outMesh.triVerts;
  const numProp = outMesh.numProp || 3;
  const triCount = outTris.length / 3;
  const positions = new Float32Array(triCount * 9);

  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vIdx = outTris[t * 3 + k] * numProp;
      positions[t * 9 + k * 3] = outVerts[vIdx];
      positions[t * 9 + k * 3 + 1] = outVerts[vIdx + 1];
      positions[t * 9 + k * 3 + 2] = outVerts[vIdx + 2];
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingBox();
  const center = new THREE.Vector3();
  geo.boundingBox.getCenter(center);
  geo.translate(-center.x, -center.y, -center.z);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Fallback extruded profile geometry if WASM is not yet loaded.
 */
function createExtrudedProfileGeometry(points2D, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(points2D[0][0], points2D[0][1]);
  for (let i = 1; i < points2D.length; i++) {
    shape.lineTo(points2D[i][0], points2D[i][1]);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
  });

  geo.computeBoundingBox();
  const center = new THREE.Vector3();
  geo.boundingBox.getCenter(center);
  geo.translate(-center.x, -center.y, -center.z);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Generates 100% watertight TinkerCAD-style sample models with both convex and concave edges.
 */
export async function createSampleModel(sampleId = 'l-bracket') {
  const wasm = await initCSGEngine();

  if (wasm) {
    const { Manifold } = wasm;

    if (sampleId === 'stepped-block') {
      const step1 = Manifold.cube([52, 12, 34], false);
      const step2 = Manifold.cube([34, 24, 34], false);
      const step3 = Manifold.cube([16, 38, 34], false);
      const united = step1.add(step2).add(step3);
      const hole = Manifold.cylinder(20, 5, 5, 28, true)
        .rotate([90, 0, 0])
        .translate([43, 6, 17]);
      const finalManifold = united.subtract(hole);

      const geo = manifoldToThreeGeometry(finalManifold);
      step1.delete();
      step2.delete();
      step3.delete();
      united.delete();
      hole.delete();
      finalManifold.delete();

      return {
        name: 'Stepped_Mounting_Block.stl',
        geometry: geo,
      };
    }

    if (sampleId === 'flanged-pipe') {
      // Flanged cylindrical boss with through-hole (circular convex rims + circular concave neck)
      const flange = Manifold.cylinder(10, 24, 24, 36, false);
      const boss = Manifold.cylinder(32, 14, 14, 36, false);
      const bore = Manifold.cylinder(40, 7, 7, 36, false).translate([0, 0, -2]);
      const united = flange.add(boss);
      const finalManifold = united.subtract(bore).rotate([-90, 0, 0]);

      const geo = manifoldToThreeGeometry(finalManifold);
      flange.delete();
      boss.delete();
      bore.delete();
      united.delete();
      finalManifold.delete();

      return {
        name: 'Flanged_Cylinder_Boss.stl',
        geometry: geo,
      };
    }

    if (sampleId === 't-slot') {
      const outer = Manifold.cube([48, 30, 38], false);
      const innerWide = Manifold.cube([28, 12, 44], false).translate([10, 8, -3]);
      const innerNeck = Manifold.cube([16, 16, 44], false).translate([16, 18, -3]);
      const slot = innerWide.add(innerNeck);
      const finalManifold = outer.subtract(slot);

      const geo = manifoldToThreeGeometry(finalManifold);
      outer.delete();
      innerWide.delete();
      innerNeck.delete();
      slot.delete();
      finalManifold.delete();

      return {
        name: 'T_Channel_Guide.stl',
        geometry: geo,
      };
    }

    // Default: 'l-bracket'
    const horizontalLeg = Manifold.cube([45, 10, 32], false);
    const verticalLeg = Manifold.cube([10, 40, 32], false);
    const bracket = horizontalLeg.add(verticalLeg);
    const hole = Manifold.cylinder(24, 6.5, 6.5, 32, true)
      .rotate([90, 0, 0])
      .translate([28, 5, 16]);
    const finalManifold = bracket.subtract(hole);

    const geo = manifoldToThreeGeometry(finalManifold);
    horizontalLeg.delete();
    verticalLeg.delete();
    bracket.delete();
    hole.delete();
    finalManifold.delete();

    return {
      name: 'L_Bracket_With_Hole.stl',
      geometry: geo,
    };
  }

  // Pure Three.js fallback if offline
  const pts = [
    [0, 0],
    [45, 0],
    [45, 10],
    [10, 10],
    [10, 40],
    [0, 40],
  ];
  return {
    name: 'L_Bracket.stl',
    geometry: createExtrudedProfileGeometry(pts, 32),
  };
}
