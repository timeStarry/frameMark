import exifr from 'exifr';
export interface Asset {
    id: string;
    file: File;
    url: string;
    width: number;
    height: number;
    metadata: Record<string, string>;
}
export const fields: Record<string, string> = { Model: '相机', LensModel: '镜头', FocalLength: '焦距', FNumber: '光圈', ExposureTime: '快门', ISO: 'ISO' };
export async function decode(file: File, maxEdge?: number, onSize?: (s: {
    width: number;
    height: number;
}) => void): Promise<ImageBitmap> { const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); if (bitmap.width * bitmap.height > 40000000) {
    bitmap.close();
    throw new Error('图片超过 4000 万像素，请先缩小。');
} onSize?.({ width: bitmap.width, height: bitmap.height }); if (maxEdge && Math.max(bitmap.width, bitmap.height) > maxEdge) {
    try {
        return await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * maxEdge / Math.max(bitmap.width, bitmap.height))), resizeHeight: Math.max(1, Math.round(bitmap.height * maxEdge / Math.max(bitmap.width, bitmap.height))), resizeQuality: 'high' });
    }
    finally {
        bitmap.close();
    }
} return bitmap; }
// JPEG/PNG dimensions are checked before decoding. WebP is checked after bounded serial decode.
export async function preflight(file: File) { if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('仅支持 JPEG、PNG、静态 WebP。'); if (file.size > 20 * 1024 * 1024)
    throw new Error('单张图片最多 20 MiB。'); const b = new Uint8Array(await file.slice(0, 262144).arrayBuffer()); let w = 0, h = 0; if (file.type === 'image/png' && b.length >= 24) {
    const v = new DataView(b.buffer);
    w = v.getUint32(16);
    h = v.getUint32(20);
} if (file.type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 255) {
            i++;
            continue;
        }
        const marker = b[i + 1]!;
        if (marker === 0xda || marker === 0xd9)
            break;
        const len = (b[i + 2]! << 8) + b[i + 3]!;
        if (len < 2)
            break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            h = (b[i + 5]! << 8) + b[i + 6]!;
            w = (b[i + 7]! << 8) + b[i + 8]!;
            break;
        }
        i += len + 2;
    }
} if (w * h > 40000000)
    throw new Error('图片超过 4000 万像素，请先缩小。'); }
export class Assets {
    items = new Map<string, Asset>();
    disposed = false;
    async add(file: File): Promise<Asset> { await preflight(file); let source = { width: 0, height: 0 }; const bitmap = await decode(file, 320, s => source = s); if (this.disposed) {
        bitmap.close();
        throw new DOMException("已离开工具", "AbortError");
    } let metadata: Record<string, string> = {}; try {
        const raw = await exifr.parse(file, { pick: Object.keys(fields), gps: false });
        for (const key of Object.keys(fields)) {
            if (raw?.[key] != null)
                metadata[key] = String(raw[key]);
        }
    }
    catch { /* Metadata failure does not invalidate the photograph. */ } if (this.disposed) {
        bitmap.close();
        throw new DOMException("已离开工具", "AbortError");
    } const thumbnail = document.createElement("canvas"); thumbnail.width = bitmap.width; thumbnail.height = bitmap.height; let blob: Blob; try {
        thumbnail.getContext("2d")!.drawImage(bitmap, 0, 0);
        blob = await new Promise<Blob>((resolve, reject) => thumbnail.toBlob(b => b ? resolve(b) : reject(new Error("缩略图生成失败")), "image/png"));
    }
    finally {
        bitmap.close();
        thumbnail.width = thumbnail.height = 0;
    } if (this.disposed)
        throw new DOMException("已离开工具", "AbortError"); const a = { id: crypto.randomUUID(), file, url: URL.createObjectURL(blob), width: source.width, height: source.height, metadata }; this.items.set(a.id, a); return a; }
    prune(ids: Set<string>) { for (const [id, a] of this.items) {
        if (!ids.has(id)) {
            URL.revokeObjectURL(a.url);
            this.items.delete(id);
        }
    } }
    dispose() { this.disposed = true; this.prune(new Set()); }
}
