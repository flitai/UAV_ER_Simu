// 地理场景视图：底图、建筑、无人机与电磁态势。技术路线见 docs/display-route.md。
export { SceneView } from './SceneView.js'
export { protomapsStyle } from './style/protomaps.js'
export { PM, PM_NAME, PM_FONT } from './style/colors.js'
export { registerProtocols, newMap } from './init.js'
export { addHillshade, removeHillshade } from './layers/hillshade.js'
export { addBuildings3d, setBuildingsColorBySrc } from './layers/buildings3d.js'
export { installProbe, type ProbeState } from './probe.js'
export { listScenes, loadScene, type SceneSummary } from './scenePackage.js'
