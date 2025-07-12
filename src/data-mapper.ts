/**
 * ID Mapping System for Strapi v4/v5 Compatibility
 * Task 5: Data Structure Mapping
 */

import { IdMapping, StrapiFormat } from './data-types.js';

// ============================================================================
// ID MAPPER CLASS
// ============================================================================

export class IdMapper {
  private static mappings: Map<string, IdMapping> = new Map();
  private static reverseMappings: Map<string, IdMapping> = new Map();
  
  /**
   * Map v4 ID to v5 documentId
   */
  static mapV4ToV5(v4Id: string | number, contentType: string): string {
    const key = `${contentType}:${v4Id}`;
    const mapping = this.mappings.get(key);
    
    if (mapping) {
      return mapping.v5DocumentId;
    }
    
    // Generate v5-style documentId if not found
    const documentId = this.generateDocumentId(v4Id, contentType);
    
    const newMapping: IdMapping = {
      v4Id,
      v5DocumentId: documentId,
      contentType,
      createdAt: new Date().toISOString()
    };
    
    this.mappings.set(key, newMapping);
    this.reverseMappings.set(documentId, newMapping);
    
    return documentId;
  }
  
  /**
   * Map v5 documentId to v4 ID
   */
  static mapV5ToV4(documentId: string, contentType: string): string | number {
    const mapping = this.reverseMappings.get(documentId);
    
    if (mapping && mapping.contentType === contentType) {
      return mapping.v4Id;
    }
    
    // Try to find in forward mappings
    for (const [key, mapping] of this.mappings) {
      if (mapping.v5DocumentId === documentId && mapping.contentType === contentType) {
        return mapping.v4Id;
      }
    }
    
    // Extract numeric ID if possible
    const numericMatch = documentId.match(/(\d+)/);
    if (numericMatch) {
      return parseInt(numericMatch[1], 10);
    }
    
    return documentId;
  }
  
  /**
   * Generate v5-style documentId from v4 ID
   */
  private static generateDocumentId(v4Id: string | number, contentType: string): string {
    // Remove 'api::' prefix and '.content-type' suffix if present
    const cleanContentType = contentType.replace('api::', '').replace(/\.[^.]+$/, '');
    
    // Generate unique documentId
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substr(2, 8);
    
    return `${cleanContentType}_${v4Id}_${timestamp}_${randomSuffix}`;
  }
  
  /**
   * Check if mapping exists
   */
  static hasMapping(v4Id: string | number, contentType: string): boolean {
    const key = `${contentType}:${v4Id}`;
    return this.mappings.has(key);
  }
  
  /**
   * Get mapping information
   */
  static getMapping(v4Id: string | number, contentType: string): IdMapping | null {
    const key = `${contentType}:${v4Id}`;
    return this.mappings.get(key) || null;
  }
  
  /**
   * Get all mappings for a content type
   */
  static getMappingsForContentType(contentType: string): IdMapping[] {
    const results: IdMapping[] = [];
    
    for (const [key, mapping] of this.mappings) {
      if (mapping.contentType === contentType) {
        results.push(mapping);
      }
    }
    
    return results;
  }
  
  /**
   * Clear all mappings
   */
  static clearMappings(): void {
    this.mappings.clear();
    this.reverseMappings.clear();
  }
  
  /**
   * Clear mappings for specific content type
   */
  static clearMappingsForContentType(contentType: string): void {
    const keysToDelete: string[] = [];
    const documentIdsToDelete: string[] = [];
    
    for (const [key, mapping] of this.mappings) {
      if (mapping.contentType === contentType) {
        keysToDelete.push(key);
        documentIdsToDelete.push(mapping.v5DocumentId);
      }
    }
    
    keysToDelete.forEach(key => this.mappings.delete(key));
    documentIdsToDelete.forEach(docId => this.reverseMappings.delete(docId));
  }
  
  /**
   * Get mapping statistics
   */
  static getStatistics(): {
    totalMappings: number;
    contentTypes: string[];
    oldestMapping: string | null;
    newestMapping: string | null;
  } {
    const contentTypes = new Set<string>();
    let oldestDate = '';
    let newestDate = '';
    
    for (const [key, mapping] of this.mappings) {
      contentTypes.add(mapping.contentType);
      
      if (!oldestDate || mapping.createdAt < oldestDate) {
        oldestDate = mapping.createdAt;
      }
      
      if (!newestDate || mapping.createdAt > newestDate) {
        newestDate = mapping.createdAt;
      }
    }
    
    return {
      totalMappings: this.mappings.size,
      contentTypes: Array.from(contentTypes),
      oldestMapping: oldestDate || null,
      newestMapping: newestDate || null
    };
  }
  
  /**
   * Export mappings to JSON
   */
  static exportMappings(): string {
    const mappingsArray = Array.from(this.mappings.entries()).map(([key, mapping]) => ({
      key,
      ...mapping
    }));
    
    return JSON.stringify(mappingsArray, null, 2);
  }
  
  /**
   * Import mappings from JSON
   */
  static importMappings(jsonData: string): void {
    try {
      const mappingsArray = JSON.parse(jsonData);
      
      this.clearMappings();
      
      for (const item of mappingsArray) {
        const { key, ...mapping } = item;
        this.mappings.set(key, mapping);
        this.reverseMappings.set(mapping.v5DocumentId, mapping);
      }
    } catch (error) {
      throw new Error(`Failed to import mappings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// ============================================================================
// PAGINATION MAPPER CLASS
// ============================================================================

export class PaginationMapper {
  /**
   * Map pagination structure between versions
   */
  static mapPagination(pagination: any, sourceFormat: StrapiFormat, targetFormat: StrapiFormat): any {
    if (!pagination || sourceFormat === targetFormat) {
      return pagination;
    }
    
    // Both v4 and v5 have similar pagination structure
    // But v5 might have additional fields
    const basePagination = {
      page: pagination.page || 1,
      pageSize: pagination.pageSize || 25,
      pageCount: pagination.pageCount || 1,
      total: pagination.total || 0
    };
    
    if (targetFormat === 'v5') {
      return {
        ...basePagination,
        // Add v5-specific fields if needed
        ...pagination
      };
    }
    
    return basePagination;
  }
  
  /**
   * Normalize pagination parameters
   */
  static normalizePagination(pagination: any): any {
    if (!pagination) return undefined;
    
    return {
      page: Math.max(1, parseInt(pagination.page || '1', 10)),
      pageSize: Math.min(100, Math.max(1, parseInt(pagination.pageSize || '25', 10))),
      pageCount: Math.max(1, parseInt(pagination.pageCount || '1', 10)),
      total: Math.max(0, parseInt(pagination.total || '0', 10))
    };
  }
}

// ============================================================================
// MEDIA MAPPER CLASS
// ============================================================================

export class MediaMapper {
  /**
   * Transform media data between versions
   */
  static transformMedia(media: any, sourceFormat: StrapiFormat, targetFormat: StrapiFormat): any {
    if (!media || sourceFormat === targetFormat) {
      return media;
    }
    
    if (sourceFormat === 'v4' && targetFormat === 'v5') {
      return this.transformV4MediaToV5(media);
    }
    
    if (sourceFormat === 'v5' && targetFormat === 'v4') {
      return this.transformV5MediaToV4(media);
    }
    
    return media;
  }
  
  /**
   * Transform v4 media to v5 format
   */
  private static transformV4MediaToV5(media: any): any {
    if (!media || !media.attributes) return media;
    
    const { id, attributes } = media;
    
    return {
      documentId: IdMapper.mapV4ToV5(id, 'media'),
      id, // Keep original ID for compatibility
      ...attributes
    };
  }
  
  /**
   * Transform v5 media to v4 format
   */
  private static transformV5MediaToV4(media: any): any {
    if (!media || !media.documentId) return media;
    
    const { documentId, id, ...attributes } = media;
    
    return {
      id: id || IdMapper.mapV5ToV4(documentId, 'media'),
      attributes
    };
  }
  
  /**
   * Transform media array
   */
  static transformMediaArray(mediaArray: any[], sourceFormat: StrapiFormat, targetFormat: StrapiFormat): any[] {
    if (!Array.isArray(mediaArray)) return mediaArray;
    
    return mediaArray.map(media => this.transformMedia(media, sourceFormat, targetFormat));
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate unique document ID
 */
export function generateDocumentId(prefix: string = 'doc'): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substr(2, 8);
  return `${prefix}_${timestamp}_${randomSuffix}`;
}

/**
 * Extract numeric ID from document ID
 */
export function extractNumericId(documentId: string): number | null {
  const match = documentId.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if value is a valid document ID
 */
export function isValidDocumentId(value: any): boolean {
  return typeof value === 'string' && value.length > 0 && !value.includes(' ');
}

/**
 * Check if value is a valid v4 ID
 */
export function isValidV4Id(value: any): boolean {
  return typeof value === 'number' && value > 0 && Number.isInteger(value);
} 