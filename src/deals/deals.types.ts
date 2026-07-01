export interface Deal {
  id: string;          // merchant_product_id
  title: string;       // product_name without the "Save X%!" prefix
  image: string;       // merchant_image_url
  url: string;         // affiliate link (or plain feed link as fallback)
  discount: number;    // percent, e.g. 15
  price?: number | null;
  oldPrice?: number | null;
  currency?: string | null;
  description?: string | null;
}
