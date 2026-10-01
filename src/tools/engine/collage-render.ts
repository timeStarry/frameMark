import { cells, imageRect, type CollageDocument } from '../core/collage';
import { outputSize, validateOutput, validateWorkingSet, LIMITS } from '../core/document';
import { decode, type Asset } from './assets';
export async function renderCollage(d: CollageDocument, assets: Map<string, Asset>, canvas: HTMLCanvasElement, preview: boolean, check: () => void, status: (s: string) => void) { const logical = { width: d.width, height: d.height }, target = preview ? outputSize(logical, Math.min(LIMITS.previewEdge, Math.max(d.width, d.height))) : outputSize(logical, d.longEdge); validateOutput(target); const layout = cells(d); validateWorkingSet(Math.max(0, ...d.assetIds.map(id => { const a = assets.get(id); return a ? a.width * a.height : 0; })), target.width * target.height, d.assetIds.length); canvas.width = target.width; canvas.height = target.height; const ctx = canvas.getContext('2d'); if (!ctx)
    throw new Error('无法创建画布，请降低尺寸。'); const scale = target.width / d.width; ctx.scale(scale, scale); if (!d.transparent || d.format === 'image/jpeg') {
    ctx.fillStyle = d.color;
    ctx.fillRect(0, 0, d.width, d.height);
} for (const [index, cell] of layout.entries()) {
    check();
    const a = assets.get(cell.id);
    if (!a)
        throw new Error('素材不可用，请重新导入。');
    status(`正在解码 ${index + 1}/${layout.length}`);
    const placement = d.placements[cell.id] || { x: 50, y: 50, fit: 'cover' };
    const rect = imageRect(a, cell, placement);
    const bitmap = await decode(a.file, Math.max(rect.width, rect.height) * scale);
    try {
        check();
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(cell.x, cell.y, cell.width, cell.height, Math.min(d.radius, cell.width / 2, cell.height / 2));
        ctx.clip();
        ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
        status(`已绘制 ${index + 1}/${layout.length}`);
    }
    finally {
        bitmap.close();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    check();
} }
