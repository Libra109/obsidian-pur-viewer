declare module "libheif-js/libheif/libheif.js" {
  interface HeifError { code: object; message: string }
  interface HeifHandle { readonly __handle?: never }
  interface HeifContext { readonly __context?: never }
  interface DecodedHeif {
    image: object;
    channels: Array<{ id: object; width: number; height: number; stride: number; data: Uint8Array }>;
  }
  export interface HeifLibrary {
    heif_error_Ok: object;
    heif_colorspace_RGB: object;
    heif_chroma_interleaved_RGBA: object;
    heif_channel_interleaved: object;
    heif_context_alloc(): HeifContext;
    heif_context_free(context: HeifContext): void;
    heif_context_read_from_memory(context: HeifContext, data: Uint8Array): HeifError;
    heif_js_context_get_list_of_top_level_image_IDs(context: HeifContext): number[] | HeifError;
    heif_js_context_get_image_handle(context: HeifContext, id: number): HeifHandle | HeifError;
    heif_image_handle_release(handle: HeifHandle): void;
    heif_image_handle_is_primary_image(handle: HeifHandle): number;
    heif_image_handle_get_width(handle: HeifHandle): number;
    heif_image_handle_get_height(handle: HeifHandle): number;
    heif_js_decode_image2(handle: HeifHandle, colorspace: object, chroma: object):
      Promise<DecodedHeif | HeifError>;
    heif_image_release(image: object): void;
  }
  export default function createHeif(options?: {
    print?: (message: string) => void; printErr?: (message: string) => void;
  }): HeifLibrary;
}
declare module "libheif-js/libheif-wasm/libheif-bundle.js" {
  import type { HeifLibrary } from "libheif-js/libheif/libheif.js";
  export default function createHeif(options?: {
    print?: (message: string) => void; printErr?: (message: string) => void;
  }): Promise<HeifLibrary>;
}
