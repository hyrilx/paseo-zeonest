/** Only presentation metadata. Feature implementation uses the native Paseo SDK. */
export interface FeatureMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: readonly string[];
  author: string;
}
