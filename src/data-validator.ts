/**
 * Comprehensive Data Validator for Strapi v4/v5 Compatibility
 * Task 5: Data Structure Mapping
 */

import { 
  StrapiFormat, 
  ValidationReport, 
  ValidationOptions, 
  StrapiV4Item, 
  StrapiV5Item,
  UnifiedItem
} from './data-types.js';

// ============================================================================
// DATA VALIDATOR CLASS
// ============================================================================

export class DataValidator {
  private static readonly REQUIRED_V4_FIELDS = ['id', 'attributes'];
  private static readonly REQUIRED_V5_FIELDS = ['documentId'];
  
  /**
   * Validate data structure for specific format
   */
  static validateFormat(data: any, expectedFormat: StrapiFormat, options: ValidationOptions = {}): boolean {
    if (!data) return true;
    
    const opts: Required<ValidationOptions> = {
      strict: options.strict ?? false,
      allowMixed: options.allowMixed ?? false,
      checkRelations: options.checkRelations ?? true,
      maxDepth: options.maxDepth ?? 5
    };
    
    if (Array.isArray(data)) {
      return data.every(item => this.validateItem(item, expectedFormat, opts));
    }
    
    return this.validateItem(data, expectedFormat, opts);
  }
  
  /**
   * Validate single item
   */
  private static validateItem(item: any, expectedFormat: StrapiFormat, options: Required<ValidationOptions>): boolean {
    if (!item || typeof item !== 'object') return true;
    
    if (expectedFormat === 'v4') {
      return this.validateV4Item(item, options);
    }
    
    if (expectedFormat === 'v5') {
      return this.validateV5Item(item, options);
    }
    
    return false;
  }
  
  /**
   * Validate v4 item structure
   */
  private static validateV4Item(item: any, options: Required<ValidationOptions>): boolean {
    // Check for required v4 fields
    if (item.id && item.attributes && typeof item.attributes === 'object') {
      // Valid v4 format
      if (options.checkRelations) {
        return this.validateRelations(item.attributes, 'v4', options);
      }
      return true;
    }
    
    // Check for flat v4 structure (less strict)
    if (item.id && !item.attributes && !options.strict) {
      return true;
    }
    
    // Check for mixed format
    if (options.allowMixed && item.documentId) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Validate v5 item structure
   */
  private static validateV5Item(item: any, options: Required<ValidationOptions>): boolean {
    // Check for required v5 fields
    if (item.documentId) {
      // Valid v5 format
      if (options.checkRelations) {
        return this.validateRelations(item, 'v5', options);
      }
      return true;
    }
    
    // Check for mixed format
    if (options.allowMixed && item.id && item.attributes) {
      return true;
    }
    
    // Check for flat object without documentId (less strict)
    if (!options.strict && typeof item === 'object' && !item.id && !item.attributes) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Validate relations in item
   */
  private static validateRelations(item: any, format: StrapiFormat, options: Required<ValidationOptions>): boolean {
    if (!item || typeof item !== 'object') return true;
    
    for (const [key, value] of Object.entries(item)) {
      if (value && typeof value === 'object') {
        if (this.isRelationField(value, format)) {
          if (!this.validateRelation(value, format, options)) {
            return false;
          }
        }
      }
    }
    
    return true;
  }
  
  /**
   * Validate relation structure
   */
  private static validateRelation(relation: any, format: StrapiFormat, options: Required<ValidationOptions>): boolean {
    if (!relation) return true;
    
    if (format === 'v4') {
      // v4 relations should have data property
      if (relation.data !== undefined) {
        if (Array.isArray(relation.data)) {
          return relation.data.every((item: any) => this.validateItem(item, 'v4', options));
        } else {
          return this.validateItem(relation.data, 'v4', options);
        }
      }
    }
    
    if (format === 'v5') {
      // v5 relations are direct objects or arrays
      if (Array.isArray(relation)) {
        return relation.every((item: any) => this.validateItem(item, 'v5', options));
      } else if (relation.documentId) {
        return this.validateItem(relation, 'v5', options);
      }
    }
    
    return true;
  }
  
  /**
   * Check if field is a relation
   */
  private static isRelationField(value: any, format: StrapiFormat): boolean {
    if (!value || typeof value !== 'object') return false;
    
    if (format === 'v4') {
      return value.data !== undefined;
    }
    
    if (format === 'v5') {
      return Array.isArray(value) || (value.documentId !== undefined);
    }
    
    return false;
  }
  
  /**
   * Get comprehensive validation report
   */
  static getValidationReport(data: any, expectedFormat: StrapiFormat, options: ValidationOptions = {}): ValidationReport {
    const report: ValidationReport = {
      isValid: true,
      format: expectedFormat,
      itemCount: 0,
      validItems: 0,
      invalidItems: 0,
      errors: [],
      warnings: []
    };
    
    if (!data) return report;
    
    const opts: Required<ValidationOptions> = {
      strict: options.strict ?? false,
      allowMixed: options.allowMixed ?? false,
      checkRelations: options.checkRelations ?? true,
      maxDepth: options.maxDepth ?? 5
    };
    
    const items = Array.isArray(data) ? data : [data];
    report.itemCount = items.length;
    
    items.forEach((item, index) => {
      const itemValidation = this.validateItemWithDetails(item, expectedFormat, opts, index);
      
      if (itemValidation.isValid) {
        report.validItems++;
      } else {
        report.invalidItems++;
        report.errors.push(...itemValidation.errors);
      }
      
      report.warnings.push(...itemValidation.warnings);
    });
    
    report.isValid = report.invalidItems === 0;
    
    return report;
  }
  
  /**
   * Validate item with detailed error reporting
   */
  private static validateItemWithDetails(
    item: any, 
    expectedFormat: StrapiFormat, 
    options: Required<ValidationOptions>, 
    index: number
  ): { isValid: boolean; errors: string[]; warnings: string[] } {
    const result = {
      isValid: true,
      errors: [] as string[],
      warnings: [] as string[]
    };
    
    if (!item || typeof item !== 'object') {
      result.errors.push(`Item ${index}: Expected object, got ${typeof item}`);
      result.isValid = false;
      return result;
    }
    
    if (expectedFormat === 'v4') {
      if (!item.id) {
        result.errors.push(`Item ${index}: Missing required field 'id' for v4 format`);
        result.isValid = false;
      }
      
      if (!item.attributes && options.strict) {
        result.errors.push(`Item ${index}: Missing required field 'attributes' for v4 format`);
        result.isValid = false;
      }
      
      if (item.documentId && !options.allowMixed) {
        result.warnings.push(`Item ${index}: Contains v5 field 'documentId' in v4 format`);
      }
    }
    
    if (expectedFormat === 'v5') {
      if (!item.documentId) {
        result.errors.push(`Item ${index}: Missing required field 'documentId' for v5 format`);
        result.isValid = false;
      }
      
      if (item.attributes && !options.allowMixed) {
        result.warnings.push(`Item ${index}: Contains v4 field 'attributes' in v5 format`);
      }
    }
    
    // Validate relations if enabled
    if (options.checkRelations) {
      const relationValidation = this.validateRelationsWithDetails(item, expectedFormat, options, index);
      result.errors.push(...relationValidation.errors);
      result.warnings.push(...relationValidation.warnings);
      
      if (!relationValidation.isValid) {
        result.isValid = false;
      }
    }
    
    return result;
  }
  
  /**
   * Validate relations with detailed reporting
   */
  private static validateRelationsWithDetails(
    item: any, 
    format: StrapiFormat, 
    options: Required<ValidationOptions>, 
    index: number
  ): { isValid: boolean; errors: string[]; warnings: string[] } {
    const result = {
      isValid: true,
      errors: [] as string[],
      warnings: [] as string[]
    };
    
    if (!item || typeof item !== 'object') return result;
    
    for (const [key, value] of Object.entries(item)) {
      if (value && typeof value === 'object') {
        if (this.isRelationField(value, format)) {
          const relationValidation = this.validateRelationWithDetails(value, format, options, index, key);
          result.errors.push(...relationValidation.errors);
          result.warnings.push(...relationValidation.warnings);
          
          if (!relationValidation.isValid) {
            result.isValid = false;
          }
        }
      }
    }
    
    return result;
  }
  
  /**
   * Validate relation with detailed reporting
   */
  private static validateRelationWithDetails(
    relation: any, 
    format: StrapiFormat, 
    options: Required<ValidationOptions>, 
    itemIndex: number, 
    fieldName: string
  ): { isValid: boolean; errors: string[]; warnings: string[] } {
    const result = {
      isValid: true,
      errors: [] as string[],
      warnings: [] as string[]
    };
    
    if (!relation) return result;
    
    if (format === 'v4') {
      if (relation.data === undefined) {
        result.errors.push(`Item ${itemIndex}, field '${fieldName}': v4 relation missing 'data' property`);
        result.isValid = false;
      } else {
        const relationItems = Array.isArray(relation.data) ? relation.data : [relation.data];
        relationItems.forEach((relItem: any, relIndex: number) => {
          if (!this.validateItem(relItem, 'v4', options)) {
            result.errors.push(`Item ${itemIndex}, field '${fieldName}', relation ${relIndex}: Invalid v4 format`);
            result.isValid = false;
          }
        });
      }
    }
    
    if (format === 'v5') {
      if (Array.isArray(relation)) {
        relation.forEach((relItem: any, relIndex: number) => {
          if (!this.validateItem(relItem, 'v5', options)) {
            result.errors.push(`Item ${itemIndex}, field '${fieldName}', relation ${relIndex}: Invalid v5 format`);
            result.isValid = false;
          }
        });
      } else if (relation.documentId) {
        if (!this.validateItem(relation, 'v5', options)) {
          result.errors.push(`Item ${itemIndex}, field '${fieldName}': Invalid v5 relation format`);
          result.isValid = false;
        }
      }
    }
    
    return result;
  }
  
  /**
   * Detect data format automatically
   */
  static detectFormat(data: any): StrapiFormat | 'mixed' | 'unknown' {
    if (!data) return 'unknown';
    
    const items = Array.isArray(data) ? data : [data];
    let v4Count = 0;
    let v5Count = 0;
    let totalCount = 0;
    
    for (const item of items) {
      if (item && typeof item === 'object') {
        totalCount++;
        
        if (item.id !== undefined && item.attributes !== undefined) {
          v4Count++;
        } else if (item.documentId !== undefined) {
          v5Count++;
        }
      }
    }
    
    if (totalCount === 0) return 'unknown';
    
    if (v4Count > 0 && v5Count === 0) return 'v4';
    if (v5Count > 0 && v4Count === 0) return 'v5';
    if (v4Count > 0 && v5Count > 0) return 'mixed';
    
    return 'unknown';
  }
  
  /**
   * Get format statistics
   */
  static getFormatStatistics(data: any): {
    totalItems: number;
    v4Items: number;
    v5Items: number;
    unknownItems: number;
    detectedFormat: StrapiFormat | 'mixed' | 'unknown';
    formatDistribution: Record<string, number>;
  } {
    const stats = {
      totalItems: 0,
      v4Items: 0,
      v5Items: 0,
      unknownItems: 0,
      detectedFormat: 'unknown' as StrapiFormat | 'mixed' | 'unknown',
      formatDistribution: {} as Record<string, number>
    };
    
    if (!data) return stats;
    
    const items = Array.isArray(data) ? data : [data];
    
    for (const item of items) {
      if (item && typeof item === 'object') {
        stats.totalItems++;
        
        if (item.id !== undefined && item.attributes !== undefined) {
          stats.v4Items++;
        } else if (item.documentId !== undefined) {
          stats.v5Items++;
        } else {
          stats.unknownItems++;
        }
      }
    }
    
    stats.detectedFormat = this.detectFormat(data);
    
    stats.formatDistribution = {
      v4: stats.v4Items,
      v5: stats.v5Items,
      unknown: stats.unknownItems
    };
    
    return stats;
  }
  
  /**
   * Validate response structure
   */
  static validateResponse(response: any, expectedFormat: StrapiFormat, options: ValidationOptions = {}): ValidationReport {
    const report: ValidationReport = {
      isValid: true,
      format: expectedFormat,
      itemCount: 0,
      validItems: 0,
      invalidItems: 0,
      errors: [],
      warnings: []
    };
    
    if (!response) {
      report.errors.push('Response is null or undefined');
      report.isValid = false;
      return report;
    }
    
    if (typeof response !== 'object') {
      report.errors.push('Response must be an object');
      report.isValid = false;
      return report;
    }
    
    // Validate data field
    if (response.data !== undefined) {
      const dataReport = this.getValidationReport(response.data, expectedFormat, options);
      report.itemCount += dataReport.itemCount;
      report.validItems += dataReport.validItems;
      report.invalidItems += dataReport.invalidItems;
      report.errors.push(...dataReport.errors);
      report.warnings.push(...dataReport.warnings);
      
      if (!dataReport.isValid) {
        report.isValid = false;
      }
    }
    
    // Validate meta field
    if (response.meta) {
      if (typeof response.meta !== 'object') {
        report.errors.push('Meta field must be an object');
        report.isValid = false;
      } else if (response.meta.pagination) {
        const paginationValidation = this.validatePagination(response.meta.pagination);
        if (!paginationValidation.isValid) {
          report.errors.push(...paginationValidation.errors);
          report.isValid = false;
        }
      }
    }
    
    return report;
  }
  
  /**
   * Validate pagination structure
   */
  private static validatePagination(pagination: any): { isValid: boolean; errors: string[] } {
    const result = {
      isValid: true,
      errors: [] as string[]
    };
    
    if (!pagination || typeof pagination !== 'object') {
      result.errors.push('Pagination must be an object');
      result.isValid = false;
      return result;
    }
    
    const requiredFields = ['page', 'pageSize', 'pageCount', 'total'];
    
    for (const field of requiredFields) {
      if (pagination[field] === undefined) {
        result.errors.push(`Pagination missing required field: ${field}`);
        result.isValid = false;
      } else if (typeof pagination[field] !== 'number') {
        result.errors.push(`Pagination field '${field}' must be a number`);
        result.isValid = false;
      } else if (pagination[field] < 0) {
        result.errors.push(`Pagination field '${field}' must be non-negative`);
        result.isValid = false;
      }
    }
    
    return result;
  }
}

// ============================================================================
// SCHEMA VALIDATOR CLASS
// ============================================================================

export class SchemaValidator {
  /**
   * Validate item against schema
   */
  static validateAgainstSchema(item: any, schema: any, options: ValidationOptions = {}): ValidationReport {
    const report: ValidationReport = {
      isValid: true,
      format: 'v4', // Default
      itemCount: 1,
      validItems: 0,
      invalidItems: 0,
      errors: [],
      warnings: []
    };
    
    if (!schema || !schema.attributes) {
      report.errors.push('Schema is required with attributes property');
      report.isValid = false;
      return report;
    }
    
    if (!item || typeof item !== 'object') {
      report.errors.push('Item must be an object');
      report.isValid = false;
      return report;
    }
    
    // Validate each attribute
    for (const [attrName, attrSchema] of Object.entries(schema.attributes)) {
      const attrValue = item[attrName];
      const attrValidation = this.validateAttribute(attrValue, attrSchema as any, attrName);
      
      if (!attrValidation.isValid) {
        report.errors.push(...attrValidation.errors);
        report.isValid = false;
      }
      
      report.warnings.push(...attrValidation.warnings);
    }
    
    if (report.isValid) {
      report.validItems = 1;
    } else {
      report.invalidItems = 1;
    }
    
    return report;
  }
  
  /**
   * Validate single attribute
   */
  private static validateAttribute(value: any, attrSchema: any, attrName: string): { isValid: boolean; errors: string[]; warnings: string[] } {
    const result = {
      isValid: true,
      errors: [] as string[],
      warnings: [] as string[]
    };
    
    if (!attrSchema) return result;
    
    // Check required
    if (attrSchema.required && (value === undefined || value === null)) {
      result.errors.push(`Required attribute '${attrName}' is missing`);
      result.isValid = false;
      return result;
    }
    
    if (value === undefined || value === null) {
      return result; // Optional field, no validation needed
    }
    
    // Validate type
    if (attrSchema.type) {
      const typeValidation = this.validateAttributeType(value, attrSchema.type, attrName);
      if (!typeValidation.isValid) {
        result.errors.push(...typeValidation.errors);
        result.isValid = false;
      }
    }
    
    return result;
  }
  
  /**
   * Validate attribute type
   */
  private static validateAttributeType(value: any, expectedType: string, attrName: string): { isValid: boolean; errors: string[] } {
    const result = {
      isValid: true,
      errors: [] as string[]
    };
    
    switch (expectedType) {
      case 'string':
        if (typeof value !== 'string') {
          result.errors.push(`Attribute '${attrName}' must be a string, got ${typeof value}`);
          result.isValid = false;
        }
        break;
      case 'number':
      case 'integer':
        if (typeof value !== 'number') {
          result.errors.push(`Attribute '${attrName}' must be a number, got ${typeof value}`);
          result.isValid = false;
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          result.errors.push(`Attribute '${attrName}' must be a boolean, got ${typeof value}`);
          result.isValid = false;
        }
        break;
      case 'date':
        if (typeof value !== 'string' || isNaN(Date.parse(value))) {
          result.errors.push(`Attribute '${attrName}' must be a valid date string`);
          result.isValid = false;
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          result.errors.push(`Attribute '${attrName}' must be an array, got ${typeof value}`);
          result.isValid = false;
        }
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          result.errors.push(`Attribute '${attrName}' must be an object`);
          result.isValid = false;
        }
        break;
    }
    
    return result;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Quick validation check
 */
export function isValidFormat(data: any, format: StrapiFormat): boolean {
  return DataValidator.validateFormat(data, format);
}

/**
 * Quick format detection
 */
export function detectDataFormat(data: any): StrapiFormat | 'mixed' | 'unknown' {
  return DataValidator.detectFormat(data);
}

/**
 * Validate and get summary
 */
export function validateWithSummary(data: any, expectedFormat: StrapiFormat, options: ValidationOptions = {}): {
  isValid: boolean;
  summary: string;
  details: ValidationReport;
} {
  const report = DataValidator.getValidationReport(data, expectedFormat, options);
  
  const summary = `${report.validItems}/${report.itemCount} items valid for ${expectedFormat} format. ` +
                  `${report.errors.length} errors, ${report.warnings.length} warnings.`;
  
  return {
    isValid: report.isValid,
    summary,
    details: report
  };
} 