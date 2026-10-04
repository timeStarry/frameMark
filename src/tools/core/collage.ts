import type { Size, OutputSettings } from './document';
export interface Placement {
    x: number;
    y: number;
    fit: 'cover' | 'contain';
}
export interface CollageDocument extends OutputSettings {
    kind: 'collage';
    width: number;
    height: number;
    mode: 'grid' | 'row' | 'column';
    columns: number;
    gap: number;
    padding: number;
    radius: number;
    placements: Record<string, Placement>;
}
export const collageDefaults = (): CollageDocument => ({ kind: 'collage', assetIds: [], width: 1080, height: 1080, mode: 'grid', columns: 2, gap: 16, padding: 24, radius: 0, color: '#f3f1ea', transparent: false, format: 'image/jpeg', quality: 92, longEdge: 0, placements: {} });
export interface Cell {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
export function cells(d: CollageDocument): Cell[] { const n = d.assetIds.length; if (!n)
    return []; const cols = d.mode === 'row' ? n : d.mode === 'column' ? 1 : Math.min(d.columns, 6); const rows = d.mode === 'column' ? n : d.mode === 'row' ? 1 : Math.ceil(n / cols); const width = (d.width - d.padding * 2 - d.gap * (cols - 1)) / cols, height = (d.height - d.padding * 2 - d.gap * (rows - 1)) / rows; if (!Number.isFinite(width * height) || width <= 0 || height <= 0)
    throw new Error('间距或外边距过大，照片格子没有可用面积。'); return d.assetIds.map((id, i) => ({ id, x: d.padding + (i % cols) * (width + d.gap), y: d.padding + Math.floor(i / cols) * (height + d.gap), width, height })); }
export function imageRect(source: Size, cell: Cell, p: Placement) { const scale = (p.fit === 'contain' ? Math.min : Math.max)(cell.width / source.width, cell.height / source.height); const width = source.width * scale, height = source.height * scale; return { x: cell.x + (cell.width - width) * Math.max(0, Math.min(1, p.x / 100)), y: cell.y + (cell.height - height) * Math.max(0, Math.min(1, p.y / 100)), width, height }; }
export function moveAsset(d: CollageDocument, id: string, delta: number): CollageDocument { const next = structuredClone(d), index = next.assetIds.indexOf(id), target = index + delta; if (index < 0 || target < 0 || target >= next.assetIds.length)
    return next; next.assetIds.splice(index, 1); next.assetIds.splice(target, 0, id); return next; }
export function replaceAsset(d: CollageDocument, oldId: string, newId: string): CollageDocument { const next = structuredClone(d), index = next.assetIds.indexOf(oldId); if (index < 0)
    return next; next.assetIds[index] = newId; next.placements[newId] = { ...(next.placements[oldId] || { x: 50, y: 50, fit: 'cover' }) }; delete next.placements[oldId]; return next; }
