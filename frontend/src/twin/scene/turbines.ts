import * as THREE from 'three'

/** All dimensions are metres. The rotor faces +Z and spins about its local Z axis. */
export interface TurbineModel {
  group: THREE.Group
  yaw: THREE.Group
  rotor: THREE.Group
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string) {
  const object = new THREE.Mesh(geometry, material)
  object.name = name
  object.castShadow = true
  object.receiveShadow = true
  return object
}

function box(parent: THREE.Group, dimensions: [number, number, number], position: [number, number, number], material: THREE.Material, name: string) {
  const object = mesh(new THREE.BoxGeometry(...dimensions), material, name)
  object.position.set(...position)
  parent.add(object)
  return object
}

type Bar = [THREE.Vector3, THREE.Vector3, number]

/** Shared cylinders keep ladders, handrails and supports inexpensive to render. */
function bars(parent: THREE.Group, segments: Bar[], material: THREE.Material, name: string) {
  if (!segments.length) return
  const instances = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), material, segments.length)
  instances.name = name
  const transform = new THREE.Object3D()
  const direction = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  segments.forEach(([start, end, radius], index) => {
    direction.subVectors(end, start)
    transform.position.copy(start).add(end).multiplyScalar(0.5)
    transform.quaternion.setFromUnitVectors(up, direction.clone().normalize())
    transform.scale.set(radius, direction.length(), radius)
    transform.updateMatrix()
    instances.setMatrixAt(index, transform.matrix)
  })
  instances.castShadow = true
  instances.receiveShadow = true
  parent.add(instances)
}

function nacelleGeometry() {
  // A gently rounded machinery enclosure, including a tapered rear and shaft opening.
  const sections = [
    [-5.9, 1.35, 1.48], [-5.55, 1.9, 1.88], [-4.8, 2.28, 2.14],
    [-2.5, 2.38, 2.18], [2.8, 2.25, 2.03], [4.5, 1.92, 1.7],
    [5.25, 1.44, 1.34], [5.5, 1.27, 1.2],
  ]
  const sides = 32
  const vertices: number[] = []
  const indices: number[] = []
  sections.forEach(([z, halfWidth, halfHeight], row) => {
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * Math.PI * 2
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      vertices.push(
        Math.sign(cosine) * Math.abs(cosine) ** 0.48 * halfWidth,
        Math.sign(sine) * Math.abs(sine) ** 0.48 * halfHeight + 0.4,
        z,
      )
      if (row && side < sides) {
        const a = (row - 1) * (sides + 1) + side
        const b = row * (sides + 1) + side
        indices.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
  })
  // Close both ends; the front cap sits behind the hub bearing.
  const rear = vertices.length / 3
  vertices.push(0, 0.4, sections[0][0])
  const front = vertices.length / 3
  vertices.push(0, 0.4, sections[sections.length - 1][0])
  for (let side = 0; side < sides; side++) {
    indices.push(rear, side + 1, side)
    const end = (sections.length - 1) * (sides + 1) + side
    indices.push(front, end, end + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function bladeGeometry() {
  // Smoothly transition from a round bolted root to a twisted NACA-style section.
  // The leading edge is rounded, the trailing edge is sharp, and the tip is swept.
  const spans = [2.0, 2.8, 4, 5.5, 7.5, 10, 13, 17, 22, 28, 34, 40, 45, 49, 51, 53, 54.4, 55]
  const chords = [1.35, 1.35, 2.2, 3.4, 4.3, 4.7, 4.55, 4.3, 3.9, 3.45, 2.95, 2.4, 1.9, 1.4, 1.08, 0.7, 0.34, 0.035]
  const sides = 40
  const vertices: number[] = []
  const indices: number[] = []
  const geometry = new THREE.BufferGeometry()
  spans.forEach((radius, span) => {
    const ratio = radius / 55
    const twist = THREE.MathUtils.degToRad(21 * (1 - ratio) ** 2 + 1.4)
    const chord = chords[span]
    const rootBlend = THREE.MathUtils.smoothstep(radius, 2.8, 7.5)
    const thicknessRatio = THREE.MathUtils.lerp(0.26, 0.115, ratio)
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * Math.PI * 2
      const chordFraction = (1 - Math.cos(angle)) * 0.5
      const thickness = 5 * thicknessRatio * (
        0.2969 * Math.sqrt(chordFraction) - 0.126 * chordFraction -
        0.3516 * chordFraction ** 2 + 0.2843 * chordFraction ** 3 - 0.1036 * chordFraction ** 4
      )
      const camber = 0.018 * Math.sin(Math.PI * chordFraction) * chord
      const sectionX = THREE.MathUtils.lerp(-Math.cos(angle) * 0.675, (chordFraction - 0.33) * chord, rootBlend)
      const sectionZ = THREE.MathUtils.lerp(Math.sin(angle) * 0.675, Math.sign(Math.sin(angle)) * thickness * chord + camber, rootBlend)
      const sweep = 1.35 * ratio ** 5
      const preBend = 1.5 * ratio ** 3
      vertices.push(
        sectionX * Math.cos(twist) + sectionZ * Math.sin(twist) + sweep,
        radius,
        -sectionX * Math.sin(twist) + sectionZ * Math.cos(twist) + preBend,
      )
      if (span && side < sides) {
        const a = (span - 1) * (sides + 1) + side
        const b = span * (sides + 1) + side
        indices.push(a, a + 1, b, a + 1, b + 1, b)
      }
    }
  })
  // Three contiguous material groups avoid a draw call for every airfoil section.
  const bandStart = spans.indexOf(51) * sides * 6
  const bandCount = sides * 6
  geometry.addGroup(0, bandStart, 0)
  geometry.addGroup(bandStart, bandCount, 1)
  geometry.addGroup(bandStart + bandCount, indices.length - bandStart - bandCount, 0)
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function createTurbine(): TurbineModel {
  const group = new THREE.Group()
  group.name = 'Wind turbine · 100 m hub / 110 m rotor'
  const paint = new THREE.MeshStandardMaterial({ color: '#e5e7e3', roughness: 0.46, metalness: 0.19 })
  const bladePaint = new THREE.MeshStandardMaterial({ color: '#eeeee8', roughness: 0.39, metalness: 0.06, side: THREE.DoubleSide })
  const red = new THREE.MeshStandardMaterial({ color: '#a64a3e', roughness: 0.55, metalness: 0.07, side: THREE.DoubleSide })
  const metal = new THREE.MeshStandardMaterial({ color: '#929b99', roughness: 0.49, metalness: 0.67 })
  const dark = new THREE.MeshStandardMaterial({ color: '#343c3a', roughness: 0.72, metalness: 0.35 })
  const concrete = new THREE.MeshStandardMaterial({ color: '#aaa597', roughness: 0.94, metalness: 0 })

  const foundation = mesh(new THREE.CylinderGeometry(5.7, 6, 0.85, 48), concrete, 'Concrete foundation')
  foundation.position.y = 0.34
  group.add(foundation)
  const plinth = mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.8, 48), concrete, 'Raised concrete plinth')
  plinth.position.y = 0.95
  group.add(plinth)

  const tower = mesh(new THREE.CylinderGeometry(2, 3.8, 98.9, 48, 8), paint, 'Tapered steel tower')
  tower.position.y = 50.65
  group.add(tower)
  const seams = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.013, 5, 48), metal, 5)
  seams.name = 'Tower section joints'
  const seamTransform = new THREE.Object3D()
  ;[1.45, 24, 48, 73, 98.7].forEach((height, index) => {
    const radius = THREE.MathUtils.lerp(3.8, 2, (height - 1.2) / 98.9)
    seamTransform.position.set(0, height, 0)
    seamTransform.rotation.x = Math.PI / 2
    seamTransform.scale.setScalar(radius)
    seamTransform.updateMatrix()
    seams.setMatrixAt(index, seamTransform.matrix)
  })
  seams.castShadow = true
  group.add(seams)

  box(group, [1.38, 2.45, 0.12], [0, 2.65, 3.72], dark, 'Access door gasket')
  box(group, [1.25, 2.32, 0.15], [0, 2.65, 3.78], paint, 'Tower access door')
  box(group, [0.07, 0.3, 0.1], [0.43, 2.55, 3.9], metal, 'Door handle')
  box(group, [2.1, 0.16, 1.6], [0, 1.5, 4.6], metal, 'Service landing')
  for (let step = 0; step < 6; step++) {
    box(group, [1.2, 0.1, 0.42], [0, 0.17 + step * 0.23, 7.7 - step * 0.43], metal, 'Grated access step')
  }
  const railSegments: Bar[] = []
  for (const x of [-0.78, 0.78]) {
    railSegments.push([new THREE.Vector3(x, 1.1, 7.8), new THREE.Vector3(x, 2.55, 5.3), 0.037])
    railSegments.push([new THREE.Vector3(x, 2.55, 5.3), new THREE.Vector3(x, 2.55, 4.1), 0.037])
    for (const [y, z] of [[0.17, 7.7], [1.1, 5.9], [1.5, 4.3]]) {
      railSegments.push([new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + 1.04, z), 0.032])
    }
  }
  bars(group, railSegments, metal, 'Galvanized staircase handrails')

  const yaw = new THREE.Group()
  yaw.name = 'Yaw assembly'
  yaw.position.y = 100
  group.add(yaw)
  const bearing = mesh(new THREE.CylinderGeometry(2.1, 2.06, 0.55, 48), metal, 'Yaw bearing')
  bearing.position.y = -0.2
  yaw.add(bearing)
  yaw.add(mesh(nacelleGeometry(), paint, 'Rounded nacelle casing'))
  box(yaw, [3.2, 0.13, 2.8], [0, 2.62, -1.3], paint, 'Nacelle maintenance hatch')
  const vents = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.07, 1.85), dark, 18)
  vents.name = 'Nacelle cooling louvers'
  const ventTransform = new THREE.Object3D()
  let ventIndex = 0
  for (const side of [-1, 1]) {
    for (let row = 0; row < 9; row++) {
      ventTransform.position.set(side * 2.38, 0.05 + row * 0.16, -2.15)
      ventTransform.updateMatrix()
      vents.setMatrixAt(ventIndex++, ventTransform.matrix)
    }
  }
  yaw.add(vents)
  const roofRails: Bar[] = []
  for (const x of [-1.5, 1.5]) {
    roofRails.push([new THREE.Vector3(x, 3.4, -2.8), new THREE.Vector3(x, 3.4, 0.25), 0.025])
    for (const z of [-2.8, -1.3, 0.25]) {
      roofRails.push([new THREE.Vector3(x, 2.6, z), new THREE.Vector3(x, 3.4, z), 0.025])
    }
  }
  roofRails.push([new THREE.Vector3(0, 2.55, -4.2), new THREE.Vector3(0, 4.1, -4.2), 0.055])
  roofRails.push([new THREE.Vector3(-0.6, 4.1, -4.2), new THREE.Vector3(0.6, 4.1, -4.2), 0.026])
  bars(yaw, roofRails, metal, 'Roof safety rails and wind sensor mast')
  const beaconMaterial = new THREE.MeshStandardMaterial({ color: '#bf4935', emissive: '#c72d15', emissiveIntensity: 0.7, roughness: 0.3 })
  const beacon = mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.3, 12), beaconMaterial, 'Aviation obstruction beacon')
  beacon.position.set(0, 2.9, 1.6)
  yaw.add(beacon)

  const shaft = mesh(new THREE.CylinderGeometry(1.03, 1.03, 1.9, 32), metal, 'Main rotor shaft')
  shaft.rotation.x = Math.PI / 2
  shaft.position.z = 5.95
  yaw.add(shaft)
  const rotor = new THREE.Group()
  rotor.name = 'Three-blade rotor'
  rotor.position.z = 7.5
  yaw.add(rotor)
  const blade = bladeGeometry()
  // Three separate draws retain geometry groups for the aviation bands.
  for (let index = 0; index < 3; index++) {
    const object = mesh(blade, [bladePaint, red], `Airfoil blade ${index + 1}`)
    object.rotation.z = index * Math.PI * 2 / 3
    rotor.add(object)
  }
  const spinnerProfile = [
    new THREE.Vector2(0, -1.55), new THREE.Vector2(1.56, -1.55),
    new THREE.Vector2(2.0, -0.9), new THREE.Vector2(2.08, 0),
    new THREE.Vector2(1.9, 0.85), new THREE.Vector2(1.42, 1.75),
    new THREE.Vector2(0.68, 2.4), new THREE.Vector2(0.03, 2.62),
    new THREE.Vector2(0, 2.62),
  ]
  const spinner = mesh(new THREE.LatheGeometry(spinnerProfile, 48), paint, 'Streamlined rotor hub')
  spinner.rotation.x = Math.PI / 2
  rotor.add(spinner)
  return { group, yaw, rotor }
}

/** Fixed-tilt utility PV tables. Width/depth describe the available plot in metres. */
export function createSolarArray(width = 32, depth = 24): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Photovoltaic tables'
  const frame = new THREE.MeshStandardMaterial({ color: '#9aa5ab', roughness: 0.34, metalness: 0.82 })
  const cells = new THREE.MeshStandardMaterial({ color: '#122d44', roughness: 0.25, metalness: 0.32 })
  const gridMaterial = new THREE.MeshStandardMaterial({ color: '#7c949d', roughness: 0.4, metalness: 0.55 })
  const concrete = new THREE.MeshStandardMaterial({ color: '#a9a69b', roughness: 0.95 })
  const panelWidth = 1.12
  const panelLength = 2.26
  const tilt = -Math.PI / 7
  const columns = Math.max(1, Math.floor(width / 1.2))
  const rows = Math.max(1, Math.floor(depth / 5.5))
  const panelCount = columns * rows * 2
  const frames = new THREE.InstancedMesh(new THREE.BoxGeometry(panelWidth, 0.055, panelLength), frame, panelCount)
  const glazing = new THREE.InstancedMesh(new THREE.BoxGeometry(panelWidth - 0.045, 0.012, panelLength - 0.045), cells, panelCount)
  const cellLines = new THREE.InstancedMesh(new THREE.BoxGeometry(panelWidth - 0.05, 0.014, 0.008), gridMaterial, panelCount * 11)
  const cellColumns = new THREE.InstancedMesh(new THREE.BoxGeometry(0.005, 0.014, panelLength - 0.05), gridMaterial, panelCount * 5)
  frames.name = 'Aluminum module frames'
  glazing.name = 'Monocrystalline photovoltaic glass'
  cellLines.name = 'Solar cell conductor grid'
  cellColumns.name = 'Solar cell vertical conductors'
  const transform = new THREE.Object3D()
  const offset = new THREE.Vector3()
  const supports: Bar[] = []
  const feet: THREE.Vector3[] = []
  let index = 0
  for (let row = 0; row < rows; row++) {
    const z = (row - (rows - 1) / 2) * 5.5
    for (let column = 0; column < columns; column++) {
      const x = (column - (columns - 1) / 2) * 1.2
      for (let half = 0; half < 2; half++) {
        const localZ = (half - 0.5) * 2.32
        const center = new THREE.Vector3(x, 1.55 - Math.sin(tilt) * localZ, z + Math.cos(tilt) * localZ)
        transform.position.copy(center)
        transform.rotation.set(tilt, 0, 0)
        transform.scale.setScalar(1)
        transform.updateMatrix()
        frames.setMatrixAt(index, transform.matrix)
        offset.set(0, 0.035, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt)
        transform.position.copy(center).add(offset)
        transform.updateMatrix()
        glazing.setMatrixAt(index, transform.matrix)
        for (let line = 0; line < 11; line++) {
          offset.set(0, 0.044, (line - 5) * (panelLength - 0.05) / 12).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt)
          transform.position.copy(center).add(offset)
          transform.updateMatrix()
          cellLines.setMatrixAt(index * 11 + line, transform.matrix)
        }
        for (let line = 0; line < 5; line++) {
          offset.set((line - 2) * (panelWidth - 0.05) / 6, 0.044, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt)
          transform.position.copy(center).add(offset)
          transform.updateMatrix()
          cellColumns.setMatrixAt(index * 5 + line, transform.matrix)
        }
        index++
      }
      if (column % 3 === 0 || column === columns - 1) {
        for (const localZ of [-1.3, 1.3]) {
          const top = new THREE.Vector3(x, 1.5 - Math.sin(tilt) * localZ, z + Math.cos(tilt) * localZ)
          const foot = new THREE.Vector3(top.x, 0.1, top.z)
          supports.push([foot, top, 0.045])
          feet.push(foot)
        }
        supports.push([
          new THREE.Vector3(x, 0.91, z - 1.17),
          new THREE.Vector3(x, 2.12, z + 1.17), 0.045,
        ])
      }
    }
    for (const localZ of [-1.3, 1.3]) {
      supports.push([
        new THREE.Vector3(-columns * 0.6, 1.5 - Math.sin(tilt) * localZ, z + Math.cos(tilt) * localZ),
        new THREE.Vector3(columns * 0.6, 1.5 - Math.sin(tilt) * localZ, z + Math.cos(tilt) * localZ), 0.045,
      ])
    }
  }
  const foundations = new THREE.InstancedMesh(new THREE.BoxGeometry(0.38, 0.2, 0.38), concrete, feet.length)
  foundations.name = 'Panel foundation pads'
  feet.forEach((foot, footIndex) => {
    transform.position.copy(foot)
    transform.rotation.set(0, 0, 0)
    transform.updateMatrix()
    foundations.setMatrixAt(footIndex, transform.matrix)
  })
  for (const object of [frames, glazing, cellLines, cellColumns, foundations]) {
    object.castShadow = true
    object.receiveShadow = true
    group.add(object)
  }
  bars(group, supports, frame, 'Galvanized mounting rack')
  return group
}
