/**
 * Advanced Data Transformer for Strapi v4/v5 Compatibility
 * Task 5: Data Structure Mapping
 */

import { 
  StrapiFormat, 
  TransformationOptions, 
  StrapiV4Item, 
  StrapiV5Item, 
  RelationV4, 
  RelationV5,
  UnifiedItem
} from './data-types.js';
import { IdMapper, MediaMapper } from './data-mapper.js';

// ============================================================================
// ADVANCED DATA TRANSFORMER CLASS
// ============================================================================

export class AdvancedDataTransformer {
  private static readonly MAX_DEPTH = 10;
  private static readonly CIRCULAR_REF_CACHE = new WeakSet();
  
  /**
   * Transform data based on source and target formats
   */
  static transform(
    data: any, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    options: TransformationOptions = {}
  ): any {
    if (sourceFormat === targetFormat) {
      return data; // No transformation needed
    }
    
    // Setup default options
    const opts: Required<TransformationOptions> = {
      contentType: options.contentType || 'unknown',
      preserveOriginalId: options.preserveOriginalId ?? true,
      validateResult: options.validateResult ?? false,
      depth: options.depth ?? 0
    };
    
    // Check depth limit
    if (opts.depth > this.MAX_DEPTH) {
      console.warn(`[DataTransformer] Max depth (${this.MAX_DEPTH}) reached, stopping transformation`);
      return data;
    }
    
    // Check for circular references
    if (data && typeof data === 'object' && this.CIRCULAR_REF_CACHE.has(data)) {
      console.warn(`[DataTransformer] Circular reference detected, returning reference`);
      return { __circular_ref: true };
    }
    
    if (data && typeof data === 'object') {
      this.CIRCULAR_REF_CACHE.add(data);
    }
    
    try {
      if (sourceFormat === 'v4' && targetFormat === 'v5') {
        return this.transformV4ToV5(data, opts);
      }
      
      if (sourceFormat === 'v5' && targetFormat === 'v4') {
        return this.transformV5ToV4(data, opts);
      }
      
      return data;
    } finally {
      // Clean up circular reference cache
      if (data && typeof data === 'object') {
        this.CIRCULAR_REF_CACHE.delete(data);
      }
    }
  }
  
  /**
   * Transform v4 to v5 format
   */
  private static transformV4ToV5(data: any, options: Required<TransformationOptions>): any {
    if (!data) return data;
    
    if (Array.isArray(data)) {
      return data.map(item => this.transformV4ItemToV5(item, options));
    }
    
    return this.transformV4ItemToV5(data, options);
  }
  
  /**
   * Transform single v4 item to v5
   */
  private static transformV4ItemToV5(item: any, options: Required<TransformationOptions>): any {
    if (!item || typeof item !== 'object') return item;
    
    // Handle v4 format: { id, attributes: { ... } }
    if (item.id && item.attributes) {
      const result: any = {
        documentId: IdMapper.mapV4ToV5(item.id, options.contentType),
        ...item.attributes
      };
      
      // Preserve original ID if requested
      if (options.preserveOriginalId) {
        result.id = item.id;
      }
      
      // Transform nested relations
      Object.keys(result).forEach(key => {
        if (result[key] && typeof result[key] === 'object') {
          result[key] = this.transformNestedData(
            result[key], 
            'v4', 
            'v5', 
            { ...options, depth: options.depth + 1 }
          );
        }
      });
      
      return result;
    }
    
    // Handle already flat v4 data
    if (item.id && !item.attributes) {
      const { id, ...rest } = item;
      return {
        documentId: IdMapper.mapV4ToV5(id, options.contentType),
        id: options.preserveOriginalId ? id : undefined,
        ...rest
      };
    }
    
    return item;
  }
  
  /**
   * Transform v5 to v4 format
   */
  private static transformV5ToV4(data: any, options: Required<TransformationOptions>): any {
    if (!data) return data;
    
    if (Array.isArray(data)) {
      return data.map(item => this.transformV5ItemToV4(item, options));
    }
    
    return this.transformV5ItemToV4(data, options);
  }
  
  /**
   * Transform single v5 item to v4
   */
  private static transformV5ItemToV4(item: any, options: Required<TransformationOptions>): any {
    if (!item || typeof item !== 'object') return item;
    
    // Handle v5 format: { documentId, title, ... }
    if (item.documentId) {
      const { documentId, id, ...attributes } = item;
      
      // Transform nested relations back to v4 format
      Object.keys(attributes).forEach(key => {
        if (attributes[key] && typeof attributes[key] === 'object') {
          attributes[key] = this.transformNestedData(
            attributes[key], 
            'v5', 
            'v4', 
            { ...options, depth: options.depth + 1 }
          );
        }
      });
      
      return {
        id: id || IdMapper.mapV5ToV4(documentId, options.contentType),
        attributes
      };
    }
    
    return item;
  }
  
  /**
   * Transform nested data (relations, media, etc.)
   */
  private static transformNestedData(
    data: any, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    options: Required<TransformationOptions>
  ): any {
    if (!data) return data;
    
    // Handle relation data
    if (this.isRelationData(data, sourceFormat)) {
      return this.transformRelationData(data, sourceFormat, targetFormat, options);
    }
    
    // Handle media data
    if (this.isMediaData(data)) {
      return MediaMapper.transformMedia(data, sourceFormat, targetFormat);
    }
    
    // Handle array of items
    if (Array.isArray(data)) {
      return data.map(item => this.transformNestedData(item, sourceFormat, targetFormat, options));
    }
    
    // Handle regular object
    if (typeof data === 'object') {
      return this.transform(data, sourceFormat, targetFormat, options);
    }
    
    return data;
  }
  
  /**
   * Transform relation data
   */
  private static transformRelationData(
    relationData: any, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    options: Required<TransformationOptions>
  ): any {
    if (!relationData) return relationData;
    
    if (sourceFormat === 'v4' && targetFormat === 'v5') {
      // v4: { data: { id, attributes } } → v5: { documentId, ... }
      if (relationData.data) {
        if (Array.isArray(relationData.data)) {
          return relationData.data.map((item: any) => 
            this.transformV4ItemToV5(item, { ...options, contentType: 'relation' })
          );
        } else {
          return this.transformV4ItemToV5(relationData.data, { ...options, contentType: 'relation' });
        }
      }
    }
    
    if (sourceFormat === 'v5' && targetFormat === 'v4') {
      // v5: { documentId, ... } → v4: { data: { id, attributes } }
      if (Array.isArray(relationData)) {
        return {
          data: relationData.map((item: any) => 
            this.transformV5ItemToV4(item, { ...options, contentType: 'relation' })
          )
        };
      } else if (relationData.documentId) {
        return {
          data: this.transformV5ItemToV4(relationData, { ...options, contentType: 'relation' })
        };
      }
    }
    
    return relationData;
  }
  
  /**
   * Check if data is relation data
   */
  private static isRelationData(data: any, format: StrapiFormat): boolean {
    if (!data || typeof data !== 'object') return false;
    
    if (format === 'v4') {
      return data.data !== undefined;
    }
    
    if (format === 'v5') {
      return Array.isArray(data) || (data.documentId !== undefined);
    }
    
    return false;
  }
  
  /**
   * Check if data is media data
   */
  private static isMediaData(data: any): boolean {
    if (!data || typeof data !== 'object') return false;
    
    // Check for media-specific fields
    const mediaFields = ['url', 'mime', 'hash', 'ext', 'size'];
    const hasMediaFields = mediaFields.some(field => data[field] !== undefined);
    
    return hasMediaFields && (data.id !== undefined || data.documentId !== undefined);
  }
  
  /**
   * Transform response structure
   */
  static transformResponse(
    response: any, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    options: TransformationOptions = {}
  ): any {
    if (!response || sourceFormat === targetFormat) {
      return response;
    }
    
    const transformed = { ...response };
    
    // Transform data
    if (transformed.data) {
      transformed.data = this.transform(transformed.data, sourceFormat, targetFormat, options);
    }
    
    // Transform pagination
    if (transformed.meta?.pagination) {
      // Pagination structure is similar between versions
      transformed.meta.pagination = this.transformPagination(transformed.meta.pagination);
    }
    
    return transformed;
  }
  
  /**
   * Transform pagination structure
   */
  private static transformPagination(pagination: any): any {
    if (!pagination) return pagination;
    
    return {
      page: pagination.page || 1,
      pageSize: pagination.pageSize || 25,
      pageCount: pagination.pageCount || 1,
      total: pagination.total || 0
    };
  }
  
  /**
   * Batch transform multiple items
   */
  static batchTransform(
    items: any[], 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    options: TransformationOptions = {}
  ): any[] {
    if (!Array.isArray(items)) {
      throw new Error('batchTransform requires an array of items');
    }
    
    return items.map(item => this.transform(item, sourceFormat, targetFormat, options));
  }
  
  /**
   * Transform with performance monitoring
   */
  static transformWithMetrics(
    data: any, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    options: TransformationOptions = {}
  ): { result: any; metrics: any } {
    const startTime = performance.now();
    let itemCount = 0;
    
    // Count items
    if (Array.isArray(data)) {
      itemCount = data.length;
    } else if (data && typeof data === 'object') {
      itemCount = 1;
    }
    
    const result = this.transform(data, sourceFormat, targetFormat, options);
    const endTime = performance.now();
    
    const metrics = {
      executionTime: endTime - startTime,
      itemCount,
      sourceFormat,
      targetFormat,
      averageTimePerItem: itemCount > 0 ? (endTime - startTime) / itemCount : 0
    };
    
    return { result, metrics };
  }
}

// ============================================================================
// RELATION TRANSFORMER CLASS
// ============================================================================

export class RelationTransformer {
  /**
   * Transform relation data specifically
   */
  static transformRelation(
    relation: any, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat, 
    contentType: string = 'relation'
  ): any {
    if (!relation || sourceFormat === targetFormat) {
      return relation;
    }
    
    return AdvancedDataTransformer.transform(relation, sourceFormat, targetFormat, {
      contentType,
      preserveOriginalId: true,
      validateResult: false,
      depth: 0
    });
  }
  
  /**
   * Transform multiple relations
   */
  static transformRelations(
    relations: Record<string, any>, 
    sourceFormat: StrapiFormat, 
    targetFormat: StrapiFormat
  ): Record<string, any> {
    const transformed: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(relations)) {
      transformed[key] = this.transformRelation(value, sourceFormat, targetFormat, key);
    }
    
    return transformed;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Deep clone object to avoid mutation
 */
export function deepClone(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  
  if (obj instanceof Date) return new Date(obj);
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  
  const cloned: any = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  
  return cloned;
}

/**
 * Check if transformation is needed
 */
export function needsTransformation(data: any, currentFormat: StrapiFormat, targetFormat: StrapiFormat): boolean {
  if (currentFormat === targetFormat) return false;
  if (!data) return false;
  
  // Check format indicators
  if (currentFormat === 'v4' && targetFormat === 'v5') {
    return data.id !== undefined && data.attributes !== undefined;
  }
  
  if (currentFormat === 'v5' && targetFormat === 'v4') {
    return data.documentId !== undefined;
  }
  
  return false;
}

/**
 * Get transformation statistics
 */
export function getTransformationStats(data: any): {
  totalItems: number;
  v4Items: number;
  v5Items: number;
  mixedFormat: boolean;
} {
  const stats = {
    totalItems: 0,
    v4Items: 0,
    v5Items: 0,
    mixedFormat: false
  };
  
  const items = Array.isArray(data) ? data : [data];
  
  for (const item of items) {
    if (item && typeof item === 'object') {
      stats.totalItems++;
      
      if (item.id !== undefined && item.attributes !== undefined) {
        stats.v4Items++;
      } else if (item.documentId !== undefined) {
        stats.v5Items++;
      }
    }
  }
  
  stats.mixedFormat = stats.v4Items > 0 && stats.v5Items > 0;
  
  return stats;
} 