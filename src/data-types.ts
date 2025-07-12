/**
 * Data Types for Strapi v4/v5 Compatibility
 * Task 5: Data Structure Mapping
 */

// ============================================================================
// ID MAPPING TYPES
// ============================================================================

export interface IdMapping {
  v4Id: string | number;
  v5DocumentId: string;
  contentType: string;
  createdAt: string;
}

// ============================================================================
// STRAPI V4 TYPES
// ============================================================================

export interface StrapiV4Item {
  id: number;
  attributes: Record<string, any>;
}

export interface StrapiV4Response<T = any> {
  data: T;
  meta?: {
    pagination?: PaginationV4;
    [key: string]: any;
  };
  error?: StrapiError;
}

export interface PaginationV4 {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

export interface MediaV4 {
  id: number;
  attributes: {
    name: string;
    alternativeText: string;
    caption: string;
    width: number;
    height: number;
    formats: any;
    hash: string;
    ext: string;
    mime: string;
    size: number;
    url: string;
    previewUrl: string;
    provider: string;
    provider_metadata: any;
    createdAt: string;
    updatedAt: string;
  };
}

// ============================================================================
// STRAPI V5 TYPES
// ============================================================================

export interface StrapiV5Item {
  documentId: string;
  id?: number; // Optional for backwards compatibility
  [key: string]: any;
}

export interface StrapiV5Response<T = any> {
  data: T;
  meta?: {
    pagination?: PaginationV5;
    [key: string]: any;
  };
  error?: StrapiError;
}

export interface PaginationV5 {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  // v5 may have additional fields
}

export interface MediaV5 {
  documentId: string;
  id?: number;
  name: string;
  alternativeText: string;
  caption: string;
  width: number;
  height: number;
  formats: any;
  hash: string;
  ext: string;
  mime: string;
  size: number;
  url: string;
  previewUrl: string;
  provider: string;
  provider_metadata: any;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// COMMON TYPES
// ============================================================================

export interface StrapiError {
  status: number;
  name: string;
  message: string;
  details?: any;
}

export type StrapiFormat = 'v4' | 'v5';

export interface TransformationOptions {
  contentType?: string;
  preserveOriginalId?: boolean;
  validateResult?: boolean;
  depth?: number; // For recursive transformation
}

// ============================================================================
// VALIDATION TYPES
// ============================================================================

export interface ValidationReport {
  isValid: boolean;
  format: StrapiFormat;
  itemCount: number;
  validItems: number;
  invalidItems: number;
  errors: string[];
  warnings: string[];
}

export interface ValidationOptions {
  strict?: boolean;
  allowMixed?: boolean;
  checkRelations?: boolean;
  maxDepth?: number;
}

// ============================================================================
// RELATION TYPES
// ============================================================================

export interface RelationV4 {
  data: StrapiV4Item | StrapiV4Item[] | null;
}

export type RelationV5 = StrapiV5Item | StrapiV5Item[] | null;

// ============================================================================
// UNIFIED TYPES
// ============================================================================

export interface UnifiedResponse<T = any> {
  data: T;
  meta?: any;
  error?: StrapiError;
  format: StrapiFormat;
}

export type UnifiedItem = StrapiV4Item | StrapiV5Item;
export type UnifiedMedia = MediaV4 | MediaV5;
export type UnifiedPagination = PaginationV4 | PaginationV5; 