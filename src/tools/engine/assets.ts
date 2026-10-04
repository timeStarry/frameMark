import { LIMITS, createAssetId } from '../core/document';
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
export interface ImageInfo {
    width: number;
    height: number;
    orientation: number;
}
export async function preflight(file: File): Promise<ImageInfo> {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
        throw new Error('仅支持 JPEG、PNG、静态 WebP。');
    if (file.size > LIMITS.maxFileBytes)
        throw new Error('单张图片最多 20 MiB。');
    const b = new Uint8Array(await file.slice(0, 262144).arrayBuffer()), v = new DataView(b.buffer);
    let width = 0, height = 0, orientation = 1;
    const text = (start: number, end: number) => String.fromCharCode(...b.slice(start, end));
    if (file.type === 'image/png') {
        if (b.length < 24 || b[0] !== 137 || text(1, 4) !== 'PNG')
            throw new Error('PNG 文件头损坏。');
        width = v.getUint32(16);
        height = v.getUint32(20);
        for (let i = 8; i + 12 <= b.length;) {
            const len = v.getUint32(i), name = text(i + 4, i + 8);
            if (name === 'acTL')
                throw new Error('暂不支持动画 PNG。');
            if (name === 'IDAT')
                break;
            i += len + 12;
        }
    }
    else if (file.type === 'image/jpeg') {
        if (b[0] !== 255 || b[1] !== 216)
            throw new Error('JPEG 文件头损坏。');
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
                height = (b[i + 5]! << 8) + b[i + 6]!;
                width = (b[i + 7]! << 8) + b[i + 8]!;
                break;
            }
            i += len + 2;
        }
        try {
            orientation = Number(await exifr.orientation(b)) || 1;
        }
        catch { }
    }
    else {
        if (b.length < 30 || text(0, 4) !== 'RIFF' || text(8, 12) !== 'WEBP')
            throw new Error('WebP 文件头损坏。');
        const kind = text(12, 16);
        if (kind === 'VP8X') {
            if (b[20]! & 2)
                throw new Error('暂不支持动画 WebP。');
            width = 1 + b[24]! + (b[25]! << 8) + (b[26]! << 16);
            height = 1 + b[27]! + (b[28]! << 8) + (b[29]! << 16);
        }
        else if (kind === 'VP8L') {
            const bits = v.getUint32(21, true);
            width = (bits & 0x3fff) + 1;
            height = ((bits >>> 14) & 0x3fff) + 1;
        }
        else if (kind === 'VP8 ') {
            width = v.getUint16(26, true) & 0x3fff;
            height = v.getUint16(28, true) & 0x3fff;
        }
    }
    if (width * height > LIMITS.maxSourcePixels)
        throw new Error('图片超过 4000 万像素，请先缩小。');
    if (width < 1 || height < 1)
        throw new Error('无法识别图片尺寸，请使用标准 JPEG、PNG 或静态 WebP。');
    return orientation >= 5 && orientation <= 8 ? { width: height, height: width, orientation } : { width, height, orientation };
}
export type DecodedImage = (ImageBitmap | HTMLCanvasElement) & {
    close(): void;
};
export async function decode(file: File, maxEdge?: number, onSize?: (size: {
    width: number;
    height: number;
}) => void): Promise<DecodedImage> {
    const source = await preflight(file);
    onSize?.(source);
    const ratio = maxEdge ? Math.min(1, maxEdge / Math.max(source.width, source.height)) : 1;
    const target = { width: Math.max(1, Math.round(source.width * ratio)), height: Math.max(1, Math.round(source.height * ratio)) };
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'high' });
            if (bitmap.width !== target.width || bitmap.height !== target.height) {
                bitmap.close();
                throw new Error('浏览器图像缩放不一致');
            }
            return bitmap;
        }
        catch { /* Local HTML decoder fallback; no manual EXIF rotation. */ }
    }
    const url = URL.createObjectURL(file), image = new Image();
    try {
        image.src = url;
        await image.decode();
        if (!image.naturalWidth)
            throw new Error('图像解码失败。');
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('画布不可用。');
        ctx.drawImage(image, 0, 0, target.width, target.height);
        return Object.assign(canvas, { close() { canvas.width = canvas.height = 0; } });
    }
    finally {
        image.src = '';
        URL.revokeObjectURL(url);
    }
}
export class Assets {
    items = new Map<string, Asset>();
    disposed = false;
    async add(file: File): Promise<Asset> {
        await preflight(file);
        let source = { width: 0, height: 0 };
        const bitmap = await decode(file, LIMITS.thumbnailEdge, s => source = s);
        if (this.disposed) {
            bitmap.close();
            throw new DOMException("已离开工具", "AbortError");
        }
        let metadata: Record<string, string> = {};
        try {
            const raw = await exifr.parse(file, { pick: Object.keys(fields), gps: false });
            for (const key of Object.keys(fields)) {
                if (raw?.[key] != null)
                    metadata[key] = String(raw[key]);
            }
        }
        catch { /* Metadata failure does not invalidate the photograph. */ }
        if (this.disposed) {
            bitmap.close();
            throw new DOMException("已离开工具", "AbortError");
        }
        const thumbnail = document.createElement("canvas");
        thumbnail.width = bitmap.width;
        thumbnail.height = bitmap.height;
        let blob: Blob;
        try {
            thumbnail.getContext("2d")!.drawImage(bitmap, 0, 0);
            blob = await new Promise<Blob>((resolve, reject) => thumbnail.toBlob(b => b ? resolve(b) : reject(new Error("缩略图生成失败")), "image/png"));
        }
        finally {
            bitmap.close();
            thumbnail.width = thumbnail.height = 0;
        }
        if (this.disposed)
            throw new DOMException("已离开工具", "AbortError");
        const a = { id: createAssetId(), file, url: URL.createObjectURL(blob), width: source.width, height: source.height, metadata };
        this.items.set(a.id, a);
        return a;
    }
    prune(ids: Set<string>) {
        for (const [id, a] of this.items) {
            if (!ids.has(id)) {
                URL.revokeObjectURL(a.url);
                this.items.delete(id);
            }
        }
    }
    dispose() { this.disposed = true; this.prune(new Set()); }
}
