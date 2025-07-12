#!/usr/bin/env node

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  process.exit(1); // Mandatory exit after uncaught exception
});

/**
 * Strapi MCP Server
 * 
 * This MCP server integrates with any Strapi CMS instance to provide:
 * - Access to Strapi content types as resources
 * - Tools to create and update content types in Strapi
 * - Tools to manage content entries (create, read, update, delete)
 * - Support for Strapi in development mode
 * 
 * This server is designed to be generic and work with any Strapi instance,
 * regardless of the content types defined in that instance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  ReadResourceRequest,
  CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// ============================================================================
// TASK 6: ID vs DocumentID Migration
// ============================================================================

/**
 * ID Mapping interface for v4 <-> v5 conversion
 */
interface IdMapping {
  v4Id: string | number;
  v5DocumentId: string;
  contentType: string;
  createdAt: string;
}

/**
 * ID Mapper class for handling v4 <-> v5 ID conversions
 */
class IdMapper {
  private static mappings: Map<string, IdMapping> = new Map();
  
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
    const documentId = `${contentType.replace(/[^a-zA-Z0-9]/g, '_')}_${v4Id}_${Date.now()}`;
    
    this.mappings.set(key, {
      v4Id,
      v5DocumentId: documentId,
      contentType,
      createdAt: new Date().toISOString()
    });
    
    return documentId;
  }
  
  /**
   * Map v5 documentId to v4 ID
   */
  static mapV5ToV4(documentId: string, contentType: string): string | number {
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
   * Clear mappings for testing
   */
  static clearMappings(): void {
    this.mappings.clear();
  }
}

/**
 * ID Parameter Handler for resolving ID parameters based on Strapi version
 */
class IdParameterHandler {
  /**
   * Resolve ID parameter based on Strapi version
   */
  static resolveIdParameter(id: string, contentType: string): { param: string; value: string } {
    if (detectedStrapiVersion === 'v5') {
      // v5 uses documentId
      if (this.isDocumentId(id)) {
        return { param: 'documentId', value: id };
      }
      // Convert numeric ID to documentId if needed
      const documentId = IdMapper.mapV4ToV5(id, contentType);
      return { param: 'documentId', value: documentId };
    } else {
      // v4 uses id
      if (this.isDocumentId(id)) {
        const numericId = IdMapper.mapV5ToV4(id, contentType);
        return { param: 'id', value: numericId.toString() };
      }
      return { param: 'id', value: id };
    }
  }
  
  /**
   * Check if value looks like a documentId
   */
  private static isDocumentId(value: string): boolean {
    // documentId is typically a string with letters and length > 10
    return /[a-zA-Z]/.test(value) && value.length > 10;
  }
  
  /**
   * Build endpoint with correct ID parameter
   */
  static buildEndpoint(baseEndpoint: string, id: string, contentType: string): string {
    const { param, value } = this.resolveIdParameter(id, contentType);
    
    if (detectedStrapiVersion === 'v5') {
      // v5 uses documentId in path
      return `${baseEndpoint}/${value}`;
    } else {
      // v4 uses id in path
      return `${baseEndpoint}/${value}`;
    }
  }
}

/**
 * ID Error Handler for handling ID-related errors
 */
class IdErrorHandler {
  /**
   * Handle ID-related errors
   */
  static handleIdError(error: any, id: string, contentType: string): Error {
    const errorMessage = error.message || error.toString();
    
    // Check for common ID-related errors
    if (errorMessage.includes('documentId') && detectedStrapiVersion === 'v4') {
      return new Error(`ID format mismatch: Trying to use documentId '${id}' with v4 instance. Expected numeric ID.`);
    }
    
    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      return new Error(`Entry not found: ${contentType}/${id}. Check if ID format is correct for ${detectedStrapiVersion}.`);
    }
    
    if (errorMessage.includes('invalid') && errorMessage.includes('id')) {
      return new Error(`Invalid ID format: '${id}' for ${detectedStrapiVersion}. Expected ${detectedStrapiVersion === 'v5' ? 'documentId (string)' : 'id (number)'}.`);
    }
    
    return error;
  }
}

// Extended error codes to include additional ones we need
enum ExtendedErrorCode {
  // Original error codes from SDK
  InvalidRequest = 'InvalidRequest',
  MethodNotFound = 'MethodNotFound',
  InvalidParams = 'InvalidParams',
  InternalError = 'InternalError',
  
  // Additional error codes
  ResourceNotFound = 'ResourceNotFound',
  AccessDenied = 'AccessDenied'
}

// Custom error class extending McpError to support our extended error codes
class ExtendedMcpError extends McpError {
  public extendedCode: ExtendedErrorCode;
  
  constructor(code: ExtendedErrorCode, message: string) {
    // Map our extended codes to standard MCP error codes when needed
    let mcpCode: ErrorCode;
    
    // Map custom error codes to standard MCP error codes
    switch (code) {
      case ExtendedErrorCode.ResourceNotFound:
      case ExtendedErrorCode.AccessDenied:
        // Map custom codes to InternalError for SDK compatibility
        mcpCode = ErrorCode.InternalError;
        break;
      case ExtendedErrorCode.InvalidRequest:
        mcpCode = ErrorCode.InvalidRequest;
        break;
      case ExtendedErrorCode.MethodNotFound:
        mcpCode = ErrorCode.MethodNotFound;
        break;
      case ExtendedErrorCode.InvalidParams:
        mcpCode = ErrorCode.InvalidParams;
        break;
      case ExtendedErrorCode.InternalError:
      default:
        mcpCode = ErrorCode.InternalError;
        break;
    }
    
    // Call super before accessing 'this'
    super(mcpCode, message);
    
    // Store the extended code for reference
    this.extendedCode = code;
  }
}

// Configuration from environment variables
const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const STRAPI_API_TOKEN = process.env.STRAPI_API_TOKEN;
const STRAPI_DEV_MODE = process.env.STRAPI_DEV_MODE === "true";
const STRAPI_ADMIN_EMAIL = process.env.STRAPI_ADMIN_EMAIL;
const STRAPI_ADMIN_PASSWORD = process.env.STRAPI_ADMIN_PASSWORD;
const STRAPI_VERSION = process.env.STRAPI_VERSION || "v5";

// Global version variable
let detectedStrapiVersion: string = "v5";

// Authentication State Management
interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  user: any | null;
  lastAuthTime: number;
  tokenExpiry: number | null;
}

let authState: AuthState = {
  isAuthenticated: false,
  token: null,
  user: null,
  lastAuthTime: 0,
  tokenExpiry: null
};

/**
 * Detect Strapi version from environment or API
 */
async function detectStrapiVersion(): Promise<string> {
  // Önce environment variable'ı kontrol et
  if (process.env.STRAPI_VERSION) {
    console.error(`[Version] Using environment variable: ${process.env.STRAPI_VERSION}`);
    return process.env.STRAPI_VERSION;
  }
  
  // v5 olarak ayarla
  console.error(`[Version] No version specified, defaulting to v5`);
  return "v5";
}

// ============================================================================
// TASK 3: BACKWARD COMPATIBILITY HEADERS
// ============================================================================

/**
 * Interface for request headers with compatibility support
 */
interface RequestHeaders {
  'Content-Type': string;
  'Authorization'?: string;
  'X-Strapi-Response-Format'?: string;
  [key: string]: string | undefined;
}

/**
 * Build headers with v4 compatibility for v5 instances
 */
function buildHeaders(endpoint: string, customHeaders: any = {}): RequestHeaders {
  const headers: RequestHeaders = {
    'Content-Type': 'application/json',
    ...customHeaders
  };
  
  // v5 için v4 uyumluluk header'ı ekle
  if (detectedStrapiVersion === 'v5') {
    headers['X-Strapi-Response-Format'] = 'v4';
    console.error(`[Headers] Added v4 compatibility header for v5 instance`);
  }
  
  // Authentication token ekle
  if (authState.token && endpoint !== '/admin/login') {
    headers['Authorization'] = `Bearer ${authState.token}`;
  }
  
  // Debug logging
  console.error(`[Headers] Request to ${endpoint}:`, Object.keys(headers));
  
  return headers;
}

/**
 * Validate response format (v4 vs v5)
 */
function validateResponseFormat(data: any, endpoint: string): void {
  // v4 format validation
  if (detectedStrapiVersion === 'v5') {
    // v5'te v4 uyumluluk header'ı ile v4 format'ı bekliyoruz
    if (data.data !== undefined) {
      console.error(`[Validation] ✅ v4 format detected for ${endpoint}`);
    } else {
      console.error(`[Validation] ⚠️ Unexpected format for ${endpoint}:`, Object.keys(data));
    }
  } else {
    // v4'te normal v4 format
    if (data.data !== undefined) {
      console.error(`[Validation] ✅ v4 format confirmed for ${endpoint}`);
    } else {
      console.error(`[Validation] ⚠️ Non-standard format for ${endpoint}:`, Object.keys(data));
    }
  }
}

/**
 * Log request summary for debugging
 */
function logRequestSummary(endpoint: string, headers: RequestHeaders, responseData: any): void {
  console.error(`[Summary] ${endpoint}:`);
  console.error(`  - Version: ${detectedStrapiVersion}`);
  console.error(`  - Compatibility Header: ${headers['X-Strapi-Response-Format'] || 'none'}`);
  console.error(`  - Auth: ${headers['Authorization'] ? 'Bearer ***' : 'none'}`);
  console.error(`  - Response Type: ${responseData.data ? 'v4 format' : 'other'}`);
  console.error(`  - Status: ✅ Success`);
}

/**
 * Content-Type specific JSON request
 */
async function makeJSONRequest(endpoint: string, options: any = {}): Promise<any> {
  return makeRequest(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
}

/**
 * FormData request (Content-Type otomatik set edilir)
 */
async function makeFormDataRequest(endpoint: string, formData: FormData): Promise<any> {
  return makeRequest(endpoint, {
    method: 'POST',
    body: formData,
    headers: {
      // FormData için Content-Type header'ı otomatik set edilir
      // 'Content-Type': 'multipart/form-data' // Bu otomatik
    }
  });
}

/**
 * Admin API specific requests
 */
async function makeAdminRequest(endpoint: string, options: any = {}): Promise<any> {
  const adminEndpoint = endpoint.startsWith('/admin') ? endpoint : `/admin${endpoint}`;
  return makeRequest(adminEndpoint, options);
}

// ============================================================================
// END TASK 3: BACKWARD COMPATIBILITY HEADERS
// ============================================================================

// ============================================================================
// TASK 4: RESPONSE PARSER REFACTORING
// ============================================================================

/**
 * v4 Response Format Interface
 */
interface StrapiV4Response<T = any> {
  data: T;
  meta?: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
    [key: string]: any;
  };
  error?: {
    status: number;
    name: string;
    message: string;
    details?: any;
  };
}

/**
 * v5 Response Format Interface (native)
 */
interface StrapiV5Response<T = any> {
  data: T; // Direct data, no attributes wrapper
  meta?: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
    [key: string]: any;
  };
  error?: {
    status: number;
    name: string;
    message: string;
    details?: any;
  };
}

/**
 * Unified Response Interface
 */
interface UnifiedResponse<T = any> {
  data: T;
  meta?: any;
  error?: any;
  format: 'v4' | 'v5';
}

/**
 * Response Parser Class
 */
class ResponseParser {
  private version: string;
  
  constructor(version: string = 'v4') {
    this.version = version;
  }
  
  /**
   * Parse response based on detected format
   */
  parse<T = any>(response: any): UnifiedResponse<T> {
    // Detect format
    const format = this.detectFormat(response);
    
    console.error(`[Parser] Detected format: ${format}`);
    
    switch (format) {
      case 'v4':
        return this.parseV4Response(response);
      case 'v5':
        return this.parseV5Response(response);
      default:
        throw new Error(`Unsupported response format: ${format}`);
    }
  }
  
  /**
   * Detect response format
   */
  private detectFormat(response: any): 'v4' | 'v5' {
    // Error response check
    if (response.error) {
      return 'v4'; // Both versions use similar error format
    }
    
    // v4 format: data with attributes
    if (response.data && Array.isArray(response.data)) {
      const firstItem = response.data[0];
      if (firstItem && firstItem.attributes) {
        return 'v4';
      }
    } else if (response.data && response.data.attributes) {
      return 'v4';
    }
    
    // v5 format: flat data structure
    if (response.data && !response.data.attributes) {
      return 'v5';
    }
    
    // Default to configured version
    return this.version === 'v5' ? 'v5' : 'v4';
  }
  
  /**
   * Parse v4 response format
   */
  private parseV4Response<T>(response: StrapiV4Response): UnifiedResponse<T> {
    return {
      data: response.data,
      meta: response.meta,
      error: response.error,
      format: 'v4'
    };
  }
  
  /**
   * Parse v5 response format
   */
  private parseV5Response<T>(response: StrapiV5Response): UnifiedResponse<T> {
    return {
      data: response.data,
      meta: response.meta,
      error: response.error,
      format: 'v5'
    };
  }
}

/**
 * Data Transformation Utilities
 */
class DataTransformer {
  /**
   * Transform v4 data to flat structure (v5-like)
   */
  static flattenV4Data(data: any): any {
    if (!data) return data;
    
    if (Array.isArray(data)) {
      return data.map(item => this.flattenV4Item(item));
    }
    
    return this.flattenV4Item(data);
  }
  
  /**
   * Transform single v4 item to flat structure
   */
  private static flattenV4Item(item: any): any {
    if (!item || typeof item !== 'object') return item;
    
    // v4 format: { id, attributes: { ... } }
    if (item.id && item.attributes) {
      return {
        id: item.id,
        documentId: item.id, // v5 compatibility
        ...item.attributes
      };
    }
    
    return item;
  }
  
  /**
   * Transform v5 data to v4 structure
   */
  static wrapV5Data(data: any): any {
    if (!data) return data;
    
    if (Array.isArray(data)) {
      return data.map(item => this.wrapV5Item(item));
    }
    
    return this.wrapV5Item(data);
  }
  
  /**
   * Transform single v5 item to v4 structure
   */
  private static wrapV5Item(item: any): any {
    if (!item || typeof item !== 'object') return item;
    
    // v5 format: { documentId, title, ... }
    if (item.documentId) {
      const { documentId, ...attributes } = item;
      return {
        id: documentId,
        attributes
      };
    }
    
    return item;
  }
}

// Global parser instance
const responseParser = new ResponseParser(detectedStrapiVersion);

/**
 * Enhanced response handler
 */
async function handleResponse<T = any>(response: Response, endpoint: string): Promise<UnifiedResponse<T>> {
  try {
    const rawData = await response.json();
    
    // Parse response with format detection
    const parsedResponse = responseParser.parse<T>(rawData);
    
    // Log parsing result
    console.error(`[Response] ${endpoint}:`);
    console.error(`  - Format: ${parsedResponse.format}`);
    console.error(`  - Data type: ${Array.isArray(parsedResponse.data) ? 'array' : typeof parsedResponse.data}`);
    console.error(`  - Meta: ${parsedResponse.meta ? 'present' : 'none'}`);
    
    return parsedResponse;
    
  } catch (error) {
    console.error(`[Response] Parse error for ${endpoint}:`, error);
    throw new Error(`Failed to parse response: ${error}`);
  }
}

/**
 * Update response parser version when detected version changes
 */
function updateResponseParserVersion(version: string): void {
  console.error(`[Parser] Updating response parser to version: ${version}`);
  // Create new parser instance with updated version
  const newParser = new ResponseParser(version);
  // Replace the global parser (TypeScript won't allow reassignment of const, so we'll use a different approach)
  Object.setPrototypeOf(responseParser, newParser);
  Object.assign(responseParser, newParser);
}

/**
 * Enhanced makeRequest with unified response handling
 */
async function makeRequestUnified(endpoint: string, options: any = {}): Promise<UnifiedResponse> {
  console.error(`[Request] Making request to: ${endpoint}`);
  
  // Ensure we have authenticated if required
  if (endpoint !== '/admin/login' && !isTokenValid()) {
    console.error(`[Request] Token validation failed, attempting to authenticate...`);
    await ensureAuthenticated();
  }
  
  // Build headers with v4 compatibility
  const headers = buildHeaders(endpoint, options.headers);
  
  const requestOptions = {
    method: options.method || 'GET',
    headers: {
      ...headers,
      ...options.headers
    },
    ...options
  };
  
  try {
    const response = await fetch(`${STRAPI_URL}${endpoint}`, requestOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Request] Error ${response.status}:`, errorText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    // Use enhanced response handler
    return await handleResponse(response, endpoint);
    
  } catch (error) {
    console.error(`[Request] Failed for ${endpoint}:`, error);
    throw error;
  }
}

// ============================================================================
// END TASK 4: RESPONSE PARSER REFACTORING
// ============================================================================

// ============================================================================
// TASK 4: ENHANCED MCP TOOL FUNCTIONS
// ============================================================================

/**
 * Enhanced fetchEntries using unified response format
 */
async function fetchEntriesUnified(contentType: string, queryParams?: QueryParams): Promise<UnifiedResponse> {
  try {
    console.error(`[MCP] Fetching entries for ${contentType} with unified response`);
    
    // Use existing fetchEntries function
    const result = await fetchEntries(contentType, queryParams);
    
    // Mock response parsing (since existing function doesn't use actual HTTP responses)
    const mockResponse = {
      data: result.data,
      meta: result.meta
    };
    
    // Parse with unified response parser
    const parsedResponse = responseParser.parse(mockResponse);
    
    // Transform data if needed
    let transformedData = parsedResponse.data;
    if (parsedResponse.format === 'v4') {
      transformedData = DataTransformer.flattenV4Data(parsedResponse.data);
    }
    
    return {
      data: transformedData,
      meta: parsedResponse.meta,
      error: parsedResponse.error,
      format: parsedResponse.format
    };
    
  } catch (error) {
    console.error(`[MCP] Enhanced fetchEntries error:`, error);
    throw error;
  }
}

/**
 * Enhanced fetchEntry using unified response format
 */
async function fetchEntryUnified(contentType: string, id: string, queryParams?: QueryParams): Promise<UnifiedResponse> {
  try {
    console.error(`[MCP] Fetching entry ${id} for ${contentType} with unified response`);
    
    // Use existing fetchEntry function
    const result = await fetchEntry(contentType, id, queryParams);
    
    // Mock response parsing (since existing function doesn't use actual HTTP responses)
    const mockResponse = {
      data: result
    };
    
    // Parse with unified response parser
    const parsedResponse = responseParser.parse(mockResponse);
    
    // Transform data if needed
    let transformedData = parsedResponse.data;
    if (parsedResponse.format === 'v4') {
      transformedData = DataTransformer.flattenV4Data(parsedResponse.data);
    }
    
    return {
      data: transformedData,
      meta: parsedResponse.meta,
      error: parsedResponse.error,
      format: parsedResponse.format
    };
    
  } catch (error) {
    console.error(`[MCP] Enhanced fetchEntry error:`, error);
    throw error;
  }
}

/**
 * Enhanced createEntry using unified response format
 */
async function createEntryUnified(contentType: string, data: any): Promise<UnifiedResponse> {
  try {
    console.error(`[MCP] Creating entry for ${contentType} with unified response`);
    
    // Transform data based on target version
    let transformedData = data;
    if (detectedStrapiVersion === 'v4') {
      // v4 expects wrapped data
      transformedData = data;
    } else {
      // v5 uses flat data structure
      transformedData = data;
    }
    
    // Use existing createEntry function
    const result = await createEntry(contentType, transformedData);
    
    // Mock response parsing
    const mockResponse = {
      data: result
    };
    
    // Parse with unified response parser
    const parsedResponse = responseParser.parse(mockResponse);
    
    return {
      data: parsedResponse.data,
      meta: parsedResponse.meta,
      error: parsedResponse.error,
      format: parsedResponse.format
    };
    
  } catch (error) {
    console.error(`[MCP] Enhanced createEntry error:`, error);
    throw error;
  }
}

/**
 * Enhanced updateEntry using unified response format
 */
async function updateEntryUnified(contentType: string, id: string, data: any): Promise<UnifiedResponse> {
  try {
    console.error(`[MCP] Updating entry ${id} for ${contentType} with unified response`);
    
    // Transform data based on target version
    let transformedData = data;
    if (detectedStrapiVersion === 'v4') {
      // v4 expects certain format
      transformedData = data;
    } else {
      // v5 uses flat data structure
      transformedData = data;
    }
    
    // Use existing updateEntry function
    const result = await updateEntry(contentType, id, transformedData);
    
    // Mock response parsing
    const mockResponse = {
      data: result
    };
    
    // Parse with unified response parser
    const parsedResponse = responseParser.parse(mockResponse);
    
    return {
      data: parsedResponse.data,
      meta: parsedResponse.meta,
      error: parsedResponse.error,
      format: parsedResponse.format
    };
    
  } catch (error) {
    console.error(`[MCP] Enhanced updateEntry error:`, error);
    throw error;
  }
}

/**
 * Enhanced deleteEntry using unified response format
 */
async function deleteEntryUnified(contentType: string, id: string): Promise<UnifiedResponse> {
  try {
    console.error(`[MCP] Deleting entry ${id} for ${contentType} with unified response`);
    
    // Use existing deleteEntry function
    await deleteEntry(contentType, id);
    
    // Mock success response
    const mockResponse = {
      data: { message: `Entry ${id} deleted successfully` },
      meta: {}
    };
    
    // Parse with unified response parser
    const parsedResponse = responseParser.parse(mockResponse);
    
    return {
      data: parsedResponse.data,
      meta: parsedResponse.meta,
      error: parsedResponse.error,
      format: parsedResponse.format
    };
    
  } catch (error) {
    console.error(`[MCP] Enhanced deleteEntry error:`, error);
    throw error;
  }
}

/**
 * Enhanced listContentTypes using unified response format
 */
async function listContentTypesUnified(): Promise<UnifiedResponse> {
  try {
    console.error(`[MCP] Listing content types with unified response`);
    
    // Use existing fetchContentTypes function
    const result = await fetchContentTypes();
    
    // Mock response parsing
    const mockResponse = {
      data: result,
      meta: { total: result.length }
    };
    
    // Parse with unified response parser
    const parsedResponse = responseParser.parse(mockResponse);
    
    return {
      data: parsedResponse.data,
      meta: parsedResponse.meta,
      error: parsedResponse.error,
      format: parsedResponse.format
    };
    
  } catch (error) {
    console.error(`[MCP] Enhanced listContentTypes error:`, error);
    throw error;
  }
}

// ============================================================================
// END TASK 4: ENHANCED MCP TOOL FUNCTIONS
// ============================================================================

// Validate required environment variables
if (!STRAPI_API_TOKEN && !(STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD)) {
  console.error("[Error] Missing required authentication. Please provide either STRAPI_API_TOKEN or both STRAPI_ADMIN_EMAIL and STRAPI_ADMIN_PASSWORD environment variables");
  process.exit(1);
}

// Only validate API token format if we don't have admin credentials (since admin creds take priority)
if (!STRAPI_ADMIN_EMAIL || !STRAPI_ADMIN_PASSWORD) {
  // If no admin credentials, validate that API token is not a placeholder
  if (STRAPI_API_TOKEN && (STRAPI_API_TOKEN === "strapi_token" || STRAPI_API_TOKEN === "your-api-token-here" || STRAPI_API_TOKEN.includes("placeholder"))) {
    console.error("[Error] STRAPI_API_TOKEN appears to be a placeholder value. Please provide a real API token from your Strapi admin panel or use admin credentials instead.");
    process.exit(1);
  }
}

console.error(`[Setup] Connecting to Strapi at ${STRAPI_URL}`);
console.error(`[Setup] Development mode: ${STRAPI_DEV_MODE ? "enabled" : "disabled"}`);

// Determine authentication method priority
if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
  console.error(`[Setup] Authentication: Using admin credentials (priority)`);
  if (STRAPI_API_TOKEN && STRAPI_API_TOKEN !== "strapi_token" && !STRAPI_API_TOKEN.includes("placeholder")) {
    console.error(`[Setup] API token also available as fallback`);
  }
} else if (STRAPI_API_TOKEN) {
  console.error(`[Setup] Authentication: Using API token`);
} else {
  console.error(`[Setup] Authentication: ERROR - No valid authentication method available`);
}

// Axios instance for Strapi API
const strapiClient = axios.create({
  baseURL: STRAPI_URL,
  headers: {
    "Content-Type": "application/json",
  },
  validateStatus: function (status) {
    // Consider only 5xx as errors - for more robust error handling
    return status < 500;
  }
});

// If API token is provided, use it
if (STRAPI_API_TOKEN) {
  strapiClient.defaults.headers.common['Authorization'] = `Bearer ${STRAPI_API_TOKEN}`;
}

// Store admin JWT token if we log in
let adminJwtToken: string | null = null;

/**
 * Enhanced admin authentication with state management and v4 compatibility
 */
async function authenticateAdmin(identifier: string, password: string): Promise<boolean> {
  try {
    console.error(`[Auth] Attempting admin login for: ${identifier}`);
    
    // Build headers with v4 compatibility
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    // Add v4 compatibility header for v5
    if (detectedStrapiVersion === 'v5') {
      headers['X-Strapi-Response-Format'] = 'v4';
      console.error(`[Admin API] Adding v4 compatibility header for Strapi v5`);
    }
    
    const response = await axios.post(`${STRAPI_URL}/admin/login`, {
      email: identifier,
      password: password
    }, { headers });
    
    console.error(`[Auth] Response status: ${response.status}`);
    
    // Handle different response formats (v4 vs v5)
    let jwtToken = null;
    let userData = null;
    
    if (response.data?.data?.token) {
      // v4 format: { data: { token: "...", user: {...} } }
      jwtToken = response.data.data.token;
      userData = response.data.data.user;
    } else if (response.data?.jwt) {
      // Alternative format: { jwt: "...", user: {...} }
      jwtToken = response.data.jwt;
      userData = response.data.user;
    }
    
    if (jwtToken) {
      // Update auth state
      authState.token = jwtToken;
      authState.user = userData;
      authState.isAuthenticated = true;
      authState.lastAuthTime = Date.now();
      
      // Legacy token storage for backward compatibility
      adminJwtToken = jwtToken;
      
      // Token expiry calculation (JWT decode)
      try {
        const payload = JSON.parse(atob(jwtToken.split('.')[1]));
        authState.tokenExpiry = payload.exp * 1000; // Convert to milliseconds
        console.error(`[Auth] Token expires at: ${new Date(authState.tokenExpiry).toISOString()}`);
      } catch (e) {
        console.error('[Auth] Could not decode JWT expiry, using 5-minute default');
        authState.tokenExpiry = Date.now() + (5 * 60 * 1000); // 5 minutes default
      }
      
      console.error(`[Auth] ✅ Admin login successful for: ${identifier}`);
      return true;
    }
    
    console.error(`[Auth] ❌ Login failed - no JWT in response`);
    console.error(`[Auth] Response data:`, JSON.stringify(response.data));
    return false;
    
  } catch (error) {
    console.error(`[Auth] ❌ Login error:`, error);
    if (axios.isAxiosError(error)) {
      console.error(`[Auth] Status: ${error.response?.status}`);
      console.error(`[Auth] Response data:`, error.response?.data);
    }
    return false;
  }
}

/**
 * Check if current token is valid
 */
function isTokenValid(): boolean {
  if (!authState.token || !authState.isAuthenticated) {
    return false;
  }
  
  // Token expiry check
  if (authState.tokenExpiry && Date.now() > authState.tokenExpiry) {
    console.error('[Auth] Token expired');
    return false;
  }
  
  // 5 dakikalık timeout check
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() - authState.lastAuthTime > fiveMinutes) {
    console.error('[Auth] Token timeout (5 minutes)');
    return false;
  }
  
  return true;
}

/**
 * Ensure authentication is valid, re-authenticate if needed
 */
async function ensureAuthenticated(): Promise<boolean> {
  if (isTokenValid()) {
    return true;
  }
  
  console.error('[Auth] Re-authentication required');
  authState.isAuthenticated = false;
  authState.token = null;
  adminJwtToken = null;
  
  // Re-authenticate if credentials are available
  if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
    return await authenticateAdmin(STRAPI_ADMIN_EMAIL, STRAPI_ADMIN_PASSWORD);
  }
  
  return false;
}

/**
 * Log in to the Strapi admin API using provided credentials
 */
async function loginToStrapiAdmin(): Promise<boolean> {
  // Use process.env directly here to ensure latest values are used
  const email = process.env.STRAPI_ADMIN_EMAIL;
  const password = process.env.STRAPI_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error("[Auth] No admin credentials found in process.env, skipping admin login");
    return false;
  }

  // Use the enhanced authenticateAdmin function instead of duplicating logic
  return await authenticateAdmin(email, password);
}

/**
 * Generic request function with enhanced authentication and v4 compatibility
 */
async function makeRequest(endpoint: string, options: any = {}): Promise<any> {
  // Authentication check - skip for login endpoint
  if (endpoint !== '/admin/login' && !await ensureAuthenticated()) {
    throw new Error('Authentication required');
  }
  
  // Build headers with compatibility using new buildHeaders function
  const headers = buildHeaders(endpoint, options.headers);
  
  const requestOptions = {
    method: options.method || 'GET',
    headers,
    ...options
  };
  
  // Remove headers from options to avoid duplication
  delete requestOptions.headers;
  requestOptions.headers = headers;
  
  console.error(`[Request] ${requestOptions.method} ${endpoint}`);
  console.error(`[Request] Headers:`, headers);
  
  try {
    const response = await axios({
      method: requestOptions.method,
      url: `${STRAPI_URL}${endpoint}`,
      headers: requestOptions.headers,
      data: requestOptions.data,
      params: requestOptions.params
    });
    
    if (response.status >= 200 && response.status < 300) {
      // Response format validation
      validateResponseFormat(response.data, endpoint);
      
      // Log request summary
      logRequestSummary(endpoint, headers, response.data);
      
      return response.data;
    } else {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
  } catch (error) {
    console.error(`[Request] Failed for ${endpoint}:`, error);
    
    // Handle 401 errors with re-authentication
    if (axios.isAxiosError(error) && error.response?.status === 401 && endpoint !== '/admin/login') {
      console.error("[Request] Authentication error detected. Attempting re-authentication...");
      authState.isAuthenticated = false;
      authState.token = null;
      
      // Try to re-authenticate
      const reAuthSuccess = await ensureAuthenticated();
      if (reAuthSuccess) {
        console.error("[Request] Re-authentication successful. Retrying original request...");
        
        // Update headers with new token using buildHeaders
        const retryHeaders = buildHeaders(endpoint, options.headers);
        
        try {
          const retryResponse = await axios({
            method: requestOptions.method,
            url: `${STRAPI_URL}${endpoint}`,
            headers: retryHeaders,
            data: requestOptions.data,
            params: requestOptions.params
          });
          
          console.error(`[Request] Retry successful, status: ${retryResponse.status}`);
          
          // Response format validation for retry
          validateResponseFormat(retryResponse.data, endpoint);
          
          // Log request summary for retry
          logRequestSummary(endpoint, retryHeaders, retryResponse.data);
          
          return retryResponse.data;
        } catch (retryError) {
          console.error(`[Request] Retry failed:`, retryError);
          throw retryError;
        }
      }
    }
    
    throw error;
  }
}

/**
 * Make a request to the admin API with enhanced authentication and v4 compatibility
 */
async function makeAdminApiRequest(endpoint: string, method: string = 'get', data?: any, params?: Record<string, any>): Promise<any> {
  // Ensure authentication before making request
  if (!await ensureAuthenticated()) {
    console.error(`[Admin API] Authentication failed. Cannot make request to ${endpoint}`);
    throw new Error("Not authenticated for admin API access");
  }
  
  const fullUrl = `${STRAPI_URL}${endpoint}`;
  console.error(`[Admin API] Making ${method.toUpperCase()} request to: ${fullUrl}`);
  
  if (data) {
    console.error(`[Admin API] Request payload: ${JSON.stringify(data, null, 2)}`);
  }
  
  // Build headers with compatibility using new buildHeaders function
  const headers = buildHeaders(endpoint, {});
  
  try {
    console.error(`[Admin API] Sending request with token: ${authState.token?.substring(0, 20)}...`);
    console.error(`[Admin API] Headers:`, headers);
    
    const response = await axios({
      method,
      url: fullUrl,
      headers,
      data, // Used for POST, PUT, etc.
      params // Used for GET requests query parameters
    });

    console.error(`[Admin API] Response status: ${response.status}`);
    if (response.data) {
      console.error(`[Admin API] Response received successfully`);
      
      // Response format validation
      validateResponseFormat(response.data, endpoint);
      
      // Log request summary
      logRequestSummary(endpoint, headers, response.data);
    }
    
    return response.data;
  } catch (error) {
    console.error(`[Admin API] Request to ${endpoint} failed:`);
    
    if (axios.isAxiosError(error)) {
      console.error(`[Admin API] Status: ${error.response?.status}`);
      console.error(`[Admin API] Error data: ${JSON.stringify(error.response?.data)}`);
      console.error(`[Admin API] Error headers: ${JSON.stringify(error.response?.headers)}`);
      
      // Check if it's an auth error (e.g., token expired)
      if (error.response?.status === 401) {
        console.error("[Admin API] Authentication error detected. Attempting re-authentication...");
        authState.isAuthenticated = false;
        authState.token = null;
        adminJwtToken = null;
        
        // Try to re-authenticate
        const reAuthSuccess = await ensureAuthenticated();
        if (reAuthSuccess) {
          console.error("[Admin API] Re-authentication successful. Retrying original request...");
          // Retry the request once after successful re-authentication
          try {
            // Build headers again with new token
            const retryHeaders = buildHeaders(endpoint, {});
            
            const retryResponse = await axios({
              method,
              url: fullUrl,
              headers: retryHeaders,
              data,
              params
            });
            console.error(`[Admin API] Retry successful, status: ${retryResponse.status}`);
            
            // Response format validation for retry
            validateResponseFormat(retryResponse.data, endpoint);
            
            // Log request summary for retry
            logRequestSummary(endpoint, retryHeaders, retryResponse.data);
            
            return retryResponse.data;
          } catch (retryError) {
            console.error(`[Admin API] Retry failed:`, retryError);
            throw retryError;
          }
        } else {
          console.error("[Admin API] Re-authentication failed. Throwing original error.");
          throw new Error("Admin re-authentication failed after token expiry.");
        }
      }
    } else {
      console.error(`[Admin API] Non-Axios error:`, error);
    }
    // If not a 401 or re-authentication failed, throw the original error
    throw error;
  }
}

// Cache for content types
let contentTypesCache: any[] = [];

/**
 * Create an MCP server with capabilities for resources and tools
 */
const server = new Server(
  {
    name: "strapi-mcp",
    version: "0.2.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

/**
 * Fetch all content types from Strapi
 */
async function fetchContentTypes(): Promise<any[]> {
  try {
     // Validate connection before attempting to fetch
     await validateStrapiConnection();
     
     console.error("[API] Fetching content types from Strapi");
 
     // If we have cached content types, return them
     // --- DEBUG: Temporarily disable cache ---
     // if (contentTypesCache.length > 0) {
     //   console.error("[API] Returning cached content types");
     //   return contentTypesCache;
     // }
     // --- END DEBUG ---

    // Helper function to process and cache content types
    const processAndCacheContentTypes = (data: any[], source: string): any[] => {
      console.error(`[API] Successfully fetched collection types from ${source}`);
      const contentTypes = data.map((item: any) => {
        const uid = item.uid;
        const apiID = uid.split('.').pop() || '';
        return {
          uid: uid,
          apiID: apiID,
          info: {
            displayName: item.info?.displayName || apiID.charAt(0).toUpperCase() + apiID.slice(1).replace(/-/g, ' '),
            description: item.info?.description || `${apiID} content type`,
          },
          attributes: item.attributes || {}
        };
      });

      // Filter out internal types
      const filteredTypes = contentTypes.filter((ct: any) =>
        !ct.uid.startsWith("admin::") &&
        !ct.uid.startsWith("plugin::")
      );

      console.error(`[API] Found ${filteredTypes.length} content types via ${source}`);
      contentTypesCache = filteredTypes; // Update cache
      return filteredTypes;
    };
 
     // --- Attempt 1: Use Admin Credentials if available ---
     console.error(`[DEBUG] Checking admin creds: EMAIL=${Boolean(STRAPI_ADMIN_EMAIL)}, PASSWORD=${Boolean(STRAPI_ADMIN_PASSWORD)}`);
     if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
       console.error("[API] Attempting to fetch content types using admin credentials");
       try {
         // Use makeAdminApiRequest which handles login
         // Try the content-type-builder endpoint first, as it's more common for schema listing
         console.error("[API] Trying admin endpoint: /content-type-builder/content-types");
         const adminResponse = await makeAdminApiRequest('/content-type-builder/content-types');
 
         console.error("[API] Admin response structure:", Object.keys(adminResponse || {}));
         
         // Strapi's admin API often wraps data, check common structures
         let adminData = null;
        if (adminResponse && adminResponse.data && Array.isArray(adminResponse.data)) {
            adminData = adminResponse.data; // Direct array in response.data
        } else if (adminResponse && Array.isArray(adminResponse)) {
            adminData = adminResponse; // Direct array response
        }
        
        if (adminData && adminData.length > 0) {
          return processAndCacheContentTypes(adminData, "Admin API (/content-type-builder/content-types)");
        } else {
           console.error("[API] Admin API response did not contain expected data array or was empty.", adminResponse);
        }
      } catch (adminError) {
        console.error(`[API] Failed to fetch content types using admin credentials:`, adminError);
        if (axios.isAxiosError(adminError)) {
          console.error(`[API] Admin API Error Status: ${adminError.response?.status}`);
          console.error(`[API] Admin API Error Data:`, adminError.response?.data);
        }
        // Don't throw, proceed to next method
      }
    } else {
       console.error("[API] Admin credentials not provided, skipping admin API attempt.");
    }

    // --- Attempt 2: Try different admin endpoints ---
    if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
      console.error("[API] Trying alternative admin endpoint: /content-manager/content-types");
      try {
        const adminResponse2 = await makeAdminApiRequest('/content-manager/content-types');
        console.error("[API] Admin response 2 structure:", Object.keys(adminResponse2 || {}));
        
        let adminData2 = null;
        if (adminResponse2 && adminResponse2.data && Array.isArray(adminResponse2.data)) {
            adminData2 = adminResponse2.data;
        } else if (adminResponse2 && Array.isArray(adminResponse2)) {
            adminData2 = adminResponse2;
        }
        
        if (adminData2 && adminData2.length > 0) {
          return processAndCacheContentTypes(adminData2, "Admin API (/content-manager/content-types)");
        }
      } catch (adminError2) {
        console.error(`[API] Alternative admin endpoint also failed:`, adminError2);
      }
    }

    // --- Attempt 3: Use API Token via strapiClient (Original Primary Method) ---
    console.error("[API] Attempting to fetch content types using API token (strapiClient)");
    try {
      // This is the most reliable way *if* the token has permissions
      const response = await strapiClient.get('/content-manager/collection-types');

      if (response.data && Array.isArray(response.data)) {
        // Note: This path might require admin permissions, often fails with API token
        return processAndCacheContentTypes(response.data, "Content Manager API (/content-manager/collection-types)");
      }
    } catch (apiError) {
      console.error(`[API] Failed to fetch from content manager API:`, apiError);
      if (axios.isAxiosError(apiError)) {
        console.error(`[API] API Error Status: ${apiError.response?.status}`);
        console.error(`[API] API Error Data:`, apiError.response?.data);
      }
    }
    
    // --- Attempt 4: Discovery via exploring known endpoints ---
    console.error(`[API] Trying content type discovery via known patterns...`);
    
    // Try to discover by checking common content types
    const commonTypes = ['article', 'page', 'post', 'user', 'category'];
    const discoveredTypes = [];
    
    for (const type of commonTypes) {
      try {
        const testResponse = await strapiClient.get(`/api/${type}?pagination[limit]=1`);
        if (testResponse.status === 200) {
          console.error(`[API] Discovered content type: api::${type}.${type}`);
          discoveredTypes.push({
            uid: `api::${type}.${type}`,
            apiID: type,
            info: {
              displayName: type.charAt(0).toUpperCase() + type.slice(1),
              description: `${type} content type (discovered)`,
            },
            attributes: {}
          });
        }
      } catch (e) {
        // Ignore 404s and continue
      }
    }
    
    if (discoveredTypes.length > 0) {
      console.error(`[API] Found ${discoveredTypes.length} content types via discovery`);
      contentTypesCache = discoveredTypes;
      return discoveredTypes;
    }
    
    // Final attempt: Try to discover content types by checking for common endpoint patterns
    // If all proper API methods failed, provide a helpful error message instead of silent failure
    let errorMessage = "Unable to fetch content types from Strapi. This could be due to:\n";
    errorMessage += "1. Strapi server not running or unreachable\n";
    errorMessage += "2. Invalid API token or insufficient permissions\n";
    errorMessage += "3. Admin credentials not working\n";
    errorMessage += "4. Database connectivity issues\n";
    errorMessage += "5. Strapi instance configuration problems\n\n";
    errorMessage += "Please check:\n";
    errorMessage += `- Strapi is running at ${STRAPI_URL}\n`;
    errorMessage += "- Your API token has proper permissions\n";
    errorMessage += "- Admin credentials are correct\n";
    errorMessage += "- Database is accessible and running\n";
    errorMessage += "- Try creating a test content type in your Strapi admin panel";
    
    throw new ExtendedMcpError(ExtendedErrorCode.InternalError, errorMessage);
    
  } catch (error: any) {
    console.error("[Error] Failed to fetch content types:", error);
    
    let errorMessage = "Failed to fetch content types";
    let errorCode = ExtendedErrorCode.InternalError;
    
    if (axios.isAxiosError(error)) {
      errorMessage += `: ${error.response?.status} ${error.response?.statusText}`;
      if (error.response?.status === 403) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Permission denied - check API token permissions)`;
      } else if (error.response?.status === 401) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Unauthorized - API token may be invalid or expired)`;
      }
    } else if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
    } else {
      errorMessage += `: ${String(error)}`;
    }
    
    throw new ExtendedMcpError(errorCode, errorMessage);
  }
}

/**
 * Interface for query parameters
 */
interface QueryParams {
  filters?: Record<string, any>;
  pagination?: {
    page?: number;
    pageSize?: number;
  };
  sort?: string[];
  populate?: string | string[] | Record<string, any>;
  fields?: string[];
}

/**
 * Fetch entries for a specific content type with optional filtering, pagination, and sorting
 */
async function fetchEntries(contentType: string, queryParams?: QueryParams): Promise<any> {
  // Validate connection before attempting to fetch
  await validateStrapiConnection();
  
  let response;
  let success = false;
  let fetchedData: any[] = [];
  let fetchedMeta: any = {};
  const collection = contentType.split(".")[1]; // Keep this for potential path variations if needed

  // --- Attempt 1: Use Admin Credentials via makeAdminApiRequest ---
  // Only attempt if admin credentials are provided
  if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
    console.error(`[API] Attempt 1: Fetching entries for ${contentType} using makeAdminApiRequest (Admin Credentials)`);
    try {
      // Use the full content type UID for the content-manager endpoint
      const adminEndpoint = `/content-manager/collection-types/${contentType}`;
      // Prepare query params for admin request (might need adjustment based on API)
      // Let's assume makeAdminApiRequest handles params correctly
      const adminParams: Record<string, any> = {};
      // Convert nested Strapi v4 params to flat query params if needed, or pass as is
      // Example: filters[field][$eq]=value, pagination[page]=1, sort=field:asc, populate=*, fields=field1,field2
      // For simplicity, let's pass the original structure first and modify makeAdminApiRequest
      if (queryParams?.filters) adminParams.filters = queryParams.filters;
      if (queryParams?.pagination) adminParams.pagination = queryParams.pagination;
      if (queryParams?.sort) adminParams.sort = queryParams.sort;
      if (queryParams?.populate) adminParams.populate = queryParams.populate;
      if (queryParams?.fields) adminParams.fields = queryParams.fields;

      // Make the request using admin credentials (modify makeAdminApiRequest to handle params)
      const adminResponse = await makeAdminApiRequest(adminEndpoint, 'get', undefined, adminParams); // Pass params here

      // Process admin response (structure might differ, e.g., response.data.results)
      if (adminResponse && adminResponse.results && Array.isArray(adminResponse.results)) {
         console.error(`[API] Successfully fetched data via admin credentials for ${contentType}`);
         // Admin API often returns data in 'results' and pagination info separately
         fetchedData = adminResponse.results;
         fetchedMeta = adminResponse.pagination || {}; // Adjust based on actual admin API response structure

         // Filter out potential errors within items
         fetchedData = fetchedData.filter((item: any) => !item?.error);

         if (fetchedData.length > 0) {
            console.error(`[API] Returning data fetched via admin credentials for ${contentType}`);
            return { data: fetchedData, meta: fetchedMeta };
         } else {
            console.error(`[API] Admin fetch succeeded for ${contentType} but returned no entries. This is normal if the content type is empty.`);
            // Don't try API token if admin succeeded but returned empty results
            return { data: [], meta: fetchedMeta };
         }
      } else {
         console.error(`[API] Admin fetch for ${contentType} did not return expected 'results' array. Response:`, adminResponse);
         console.error(`[API] Falling back to API token.`);
      }
    } catch (adminError) {
      console.error(`[API] Failed to fetch entries using admin credentials for ${contentType}:`, adminError);
      console.error(`[API] Falling back to API token.`);
    }
  } else {
     console.error("[API] Admin credentials not provided, using API token instead.");
  }

  // --- Attempt 2: Use API Token via strapiClient (as fallback) ---
  console.error(`[API] Attempt 2: Fetching entries for ${contentType} using strapiClient (API Token)`);
  try {
    const params: Record<string, any> = {};
    // ... build params from queryParams ... (existing code)
    if (queryParams?.filters) params.filters = queryParams.filters;
    if (queryParams?.pagination) params.pagination = queryParams.pagination;
    if (queryParams?.sort) params.sort = queryParams.sort;
    if (queryParams?.populate) params.populate = queryParams.populate;
    if (queryParams?.fields) params.fields = queryParams.fields;

    // Try multiple possible API paths (keep this flexibility)
    const possiblePaths = [
      `/api/${collection}`,
      `/api/${collection.toLowerCase()}`,
      // Add more variations if necessary
    ];

    for (const path of possiblePaths) {
      try {
        console.error(`[API] Trying path with strapiClient: ${path}`);
        response = await strapiClient.get(path, { params });

        if (response.data && response.data.error) {
          console.error(`[API] Path ${path} returned an error:`, response.data.error);
          continue; // Try next path
        }

        console.error(`[API] Successfully fetched data from: ${path} using strapiClient`);
        success = true;

        // Process response data
        if (response.data.data) {
          fetchedData = Array.isArray(response.data.data) ? response.data.data : [response.data.data];
          fetchedMeta = response.data.meta || {};
        } else if (Array.isArray(response.data)) {
          fetchedData = response.data;
          fetchedMeta = { pagination: { page: 1, pageSize: fetchedData.length, pageCount: 1, total: fetchedData.length } };
        } else {
           // Handle unexpected format, maybe log it
           console.warn(`[API] Unexpected response format from ${path} using strapiClient:`, response.data);
           fetchedData = response.data ? [response.data] : []; // Wrap if not null/undefined
           fetchedMeta = {};
        }

        // Filter out potential errors within items if any structure allows it
        fetchedData = fetchedData.filter((item: any) => !item?.error);

        break; // Exit loop on success
      } catch (err: any) {
        if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 403 || err.response?.status === 401)) {
          // 404: Try next path. 403/401: Permissions issue
          console.error(`[API] Path ${path} returned an error:`, { status: err.response?.status, name: err.response?.data?.error?.name || 'Unknown', message: err.response?.data?.error?.message || err.message, details: err.response?.data?.error?.details || {} });
          continue;
        }
        // For other errors, rethrow to be caught by the outer try-catch
        console.error(`[API] Unexpected error on path ${path} with strapiClient:`, err);
        throw err;
      }
    }

    // If strapiClient succeeded AND returned data, return it
    if (success && fetchedData.length > 0) {
      console.error(`[API] Returning data fetched via strapiClient for ${contentType}`);
      return { data: fetchedData, meta: fetchedMeta };
    } else if (success && fetchedData.length === 0) {
       console.error(`[API] Content type ${contentType} exists but has no entries (empty collection)`);
       // Return empty result for legitimate empty collections (not an error)
       return { data: [], meta: fetchedMeta };
    } else {
       console.error(`[API] strapiClient failed to fetch entries for ${contentType}.`);
    }

  } catch (error) {
    // Catch errors from the strapiClient attempts (excluding 404/403/401 handled above)
    console.error(`[API] Error during strapiClient fetch for ${contentType}:`, error);
  }

  // --- If we reach here, provide informative message instead of throwing error ---
  console.error(`[API] All attempts failed to fetch entries for ${contentType}`);
  
  // Instead of throwing an error, return empty result with informative message
  console.error(`[API] This could be because:`);
  console.error(`[API] 1. Content type '${contentType}' has no published entries`);
  console.error(`[API] 2. Content type API is not enabled in Strapi Settings > API Tokens > Roles`);
  console.error(`[API] 3. API token lacks permissions to access this content type`);
  console.error(`[API] 4. Content type exists only in admin but not exposed to public API`);
  console.error(`[API] Returning empty result instead of error.`);
  
  // Return empty result instead of throwing error
  return { 
    data: [], 
    meta: { 
      message: `No entries found for ${contentType}. This could be because the content type is empty, not published, or API access is not enabled.`,
      troubleshooting: [
        `Check if ${contentType} has published entries in Strapi admin panel`,
        "Verify API permissions in Settings > API Tokens > Roles",
        "Ensure content type API is enabled in Settings > API Tokens > Roles"
      ]
    } 
  };
}

/**
 * Fetch a specific entry by ID
 */
async function fetchEntry(contentType: string, id: string, queryParams?: QueryParams): Promise<any> {
  try {
    console.error(`[API] Fetching entry ${id} for content type: ${contentType}`);
    
    // Extract the collection name from the content type UID
    const collection = contentType.split(".")[1];
    
    // --- Attempt 1: Use Admin Credentials ---
    if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
      console.error(`[API] Attempt 1: Fetching entry ${id} for ${contentType} using admin credentials`);
      try {
        // Admin API for content management uses a different path structure
        // Build endpoint with correct ID parameter
        const adminEndpoint = IdParameterHandler.buildEndpoint(`/content-manager/collection-types/${contentType}`, id, contentType);
        
        // Prepare admin params
        const adminParams: Record<string, any> = {};
        if (queryParams?.populate) adminParams.populate = queryParams.populate;
        if (queryParams?.fields) adminParams.fields = queryParams.fields;
        
        // Make the request
        const adminResponse = await makeAdminApiRequest(adminEndpoint, 'get', undefined, adminParams);
        
        if (adminResponse) {
          console.error(`[API] Successfully fetched entry ${id} via admin credentials`);
          return adminResponse;
        }
      } catch (adminError) {
        console.error(`[API] Failed to fetch entry ${id} using admin credentials:`, adminError);
        console.error(`[API] Falling back to API token...`);
      }
    } else {
      console.error(`[API] Admin credentials not provided, falling back to API token`);
    }
    
    // --- Attempt 2: Use API Token as fallback ---
    // Build query parameters only for populate and fields
    const params: Record<string, any> = {};
    if (queryParams?.populate) {
      params.populate = queryParams.populate;
    }
    if (queryParams?.fields) {
      params.fields = queryParams.fields;
    }

    console.error(`[API] Attempt 2: Fetching entry ${id} for ${contentType} using API token`);
    
    // Build endpoint with correct ID parameter
    const endpoint = IdParameterHandler.buildEndpoint(`/api/${collection}`, id, contentType);
    
    // Get the entry from Strapi
    const response = await strapiClient.get(endpoint, { params });
    
    return response.data.data;
  } catch (error: any) {
    console.error(`[Error] Failed to fetch entry ${id} for ${contentType}:`, error);
    
    // Handle ID-related errors
    const handledError = IdErrorHandler.handleIdError(error, id, contentType);
    if (handledError !== error) {
      throw handledError;
    }
    
    let errorMessage = `Failed to fetch entry ${id} for ${contentType}`;
    let errorCode = ExtendedErrorCode.InternalError;

    if (axios.isAxiosError(error)) {
      errorMessage += `: ${error.response?.status} ${error.response?.statusText}`;
      if (error.response?.status === 404) {
        errorCode = ExtendedErrorCode.ResourceNotFound;
        errorMessage += ` (Entry not found)`;
      } else if (error.response?.status === 403) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Permission denied - check API token permissions)`;
      } else if (error.response?.status === 401) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Unauthorized - API token may be invalid or expired)`;
      }
    } else if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
    } else {
      errorMessage += `: ${String(error)}`;
    }
    
    throw new ExtendedMcpError(errorCode, errorMessage);
  }
}

/**
 * Create a new entry
 */
async function createEntry(contentType: string, data: any): Promise<any> {
  try {
    console.error(`[API] Creating new entry for content type: ${contentType}`);
    
    // STEP 1: Validate content type schema before creating entry
    console.error(`[API] Validating schema for content type: ${contentType}`);
    let contentTypeSchema;
    try {
      contentTypeSchema = await fetchContentTypeSchema(contentType);
      console.error(`[API] Schema validation successful for ${contentType}`);
    } catch (schemaError) {
      console.error(`[API] Failed to fetch schema for ${contentType}:`, schemaError);
      throw new McpError(
        ErrorCode.InvalidParams,
        `Content type ${contentType} does not exist or schema is not accessible. Please check the content type name.`
      );
    }

    // STEP 2: Validate required fields based on schema
    if (contentTypeSchema?.schema?.attributes) {
      const requiredFields = Object.entries(contentTypeSchema.schema.attributes)
        .filter(([_, attr]: [string, any]) => attr.required === true)
        .map(([fieldName, _]) => fieldName);

      const missingFields = requiredFields.filter(field => 
        data[field] === undefined || data[field] === null || data[field] === ''
      );

      if (missingFields.length > 0) {
        console.error(`[API] Missing required fields for ${contentType}:`, missingFields);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required fields for ${contentType}: ${missingFields.join(', ')}. Required fields: ${requiredFields.join(', ')}`
        );
      }

      console.error(`[API] Required field validation passed for ${contentType}`);
    }

    // STEP 3: Validate field types and constraints
    if (contentTypeSchema?.schema?.attributes) {
      const validationErrors = [];
      
      for (const [fieldName, fieldValue] of Object.entries(data)) {
        const fieldSchema = contentTypeSchema.schema.attributes[fieldName];
        
        if (!fieldSchema) {
          validationErrors.push(`Field '${fieldName}' does not exist in schema`);
          continue;
        }

        // Check string max length
        if (fieldSchema.type === 'string' && fieldSchema.maxLength && typeof fieldValue === 'string') {
          if (fieldValue.length > fieldSchema.maxLength) {
            validationErrors.push(`Field '${fieldName}' exceeds maximum length of ${fieldSchema.maxLength} characters`);
          }
        }

        // Check text max length
        if (fieldSchema.type === 'text' && fieldSchema.maxLength && typeof fieldValue === 'string') {
          if (fieldValue.length > fieldSchema.maxLength) {
            validationErrors.push(`Field '${fieldName}' exceeds maximum length of ${fieldSchema.maxLength} characters`);
          }
        }

        // Check number constraints
        if (fieldSchema.type === 'number' && typeof fieldValue === 'number') {
          if (fieldSchema.min !== undefined && fieldValue < fieldSchema.min) {
            validationErrors.push(`Field '${fieldName}' is below minimum value of ${fieldSchema.min}`);
          }
          if (fieldSchema.max !== undefined && fieldValue > fieldSchema.max) {
            validationErrors.push(`Field '${fieldName}' is above maximum value of ${fieldSchema.max}`);
          }
        }
      }

      if (validationErrors.length > 0) {
        console.error(`[API] Field validation errors for ${contentType}:`, validationErrors);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Field validation failed for ${contentType}: ${validationErrors.join('; ')}`
        );
      }

      console.error(`[API] Field validation passed for ${contentType}`);
    }
    
    // Extract the collection name from the content type UID
    const collection = contentType.split(".")[1];
    
    // --- Attempt 1: Use Admin Credentials via makeAdminApiRequest ---
    if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
      console.error(`[API] Attempt 1: Creating entry for ${contentType} using makeAdminApiRequest`);
      try {
        // Admin API for content management often uses a different path structure
        const adminEndpoint = `/content-manager/collection-types/${contentType}`;
        console.error(`[API] Trying admin create endpoint: ${adminEndpoint}`);
        
        // Admin API might need the data directly, not nested under 'data'
        const adminResponse = await makeAdminApiRequest(adminEndpoint, 'post', data);

        // Check response from admin API (structure might differ)
        if (adminResponse) {
          console.error(`[API] Successfully created entry via makeAdminApiRequest.`);
          // Admin API might return the created entry directly or nested under 'data'
          return adminResponse.data || adminResponse;
        } else {
          // Should not happen if makeAdminApiRequest resolves, but handle defensively
          console.warn(`[API] Admin create completed but returned no data.`);
          // Return a success indicator even without data, as the operation likely succeeded
          return { message: "Create via admin succeeded, no data returned." };
        }
      } catch (adminError) {
        console.error(`[API] Failed to create entry using admin credentials:`, adminError);
        // Only try API token if admin credentials fail
        console.error(`[API] Admin credentials failed, attempting to use API token as fallback.`);
      }
    } else {
      console.error("[API] Admin credentials not provided, falling back to API token.");
    }
    
    // --- Attempt 2: Use API Token via strapiClient (as fallback) ---
    console.error(`[API] Attempt 2: Creating entry for ${contentType} using strapiClient`);
    try {
      // Create the entry in Strapi
      const response = await strapiClient.post(`/api/${collection}`, {
        data: data
      });
      
      if (response.data && response.data.data) {
        console.error(`[API] Successfully created entry via strapiClient.`);
        return response.data.data;
      } else {
        console.warn(`[API] Create via strapiClient completed, but no data returned.`);
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to create entry for ${contentType}: No data returned from API`
        );
      }
    } catch (error) {
      console.error(`[API] Failed to create entry via strapiClient:`, error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create entry for ${contentType} via strapiClient: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } catch (error) {
    console.error(`[Error] Failed to create entry for ${contentType}:`, error);
    
    // Re-throw McpError as is
    if (error instanceof McpError) {
      throw error;
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to create entry for ${contentType}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Update an existing entry
 */
async function updateEntry(contentType: string, id: string, data: any): Promise<any> {
  try {
    console.error(`[API] Updating entry ${id} for content type: ${contentType}`);
    
    // STEP 1: Validate content type schema before updating entry
    console.error(`[API] Validating schema for content type: ${contentType}`);
    let contentTypeSchema;
    try {
      contentTypeSchema = await fetchContentTypeSchema(contentType);
      console.error(`[API] Schema validation successful for ${contentType}`);
    } catch (schemaError) {
      console.error(`[API] Failed to fetch schema for ${contentType}:`, schemaError);
      throw new McpError(
        ErrorCode.InvalidParams,
        `Content type ${contentType} does not exist or schema is not accessible. Please check the content type name.`
      );
    }

    // STEP 2: Validate field types and constraints (for update, required fields are not mandatory)
    if (contentTypeSchema?.schema?.attributes) {
      const validationErrors = [];
      
      for (const [fieldName, fieldValue] of Object.entries(data)) {
        const fieldSchema = contentTypeSchema.schema.attributes[fieldName];
        
        if (!fieldSchema) {
          validationErrors.push(`Field '${fieldName}' does not exist in schema`);
          continue;
        }

        // Check string max length
        if (fieldSchema.type === 'string' && fieldSchema.maxLength && typeof fieldValue === 'string') {
          if (fieldValue.length > fieldSchema.maxLength) {
            validationErrors.push(`Field '${fieldName}' exceeds maximum length of ${fieldSchema.maxLength} characters`);
          }
        }

        // Check text max length
        if (fieldSchema.type === 'text' && fieldSchema.maxLength && typeof fieldValue === 'string') {
          if (fieldValue.length > fieldSchema.maxLength) {
            validationErrors.push(`Field '${fieldName}' exceeds maximum length of ${fieldSchema.maxLength} characters`);
          }
        }

        // Check number constraints
        if (fieldSchema.type === 'number' && typeof fieldValue === 'number') {
          if (fieldSchema.min !== undefined && fieldValue < fieldSchema.min) {
            validationErrors.push(`Field '${fieldName}' is below minimum value of ${fieldSchema.min}`);
          }
          if (fieldSchema.max !== undefined && fieldValue > fieldSchema.max) {
            validationErrors.push(`Field '${fieldName}' is above maximum value of ${fieldSchema.max}`);
          }
        }
      }

      if (validationErrors.length > 0) {
        console.error(`[API] Field validation errors for ${contentType}:`, validationErrors);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Field validation failed for ${contentType}: ${validationErrors.join('; ')}`
        );
      }

      console.error(`[API] Field validation passed for ${contentType}`);
    }
    
    const collection = contentType.split(".")[1];

    // --- Attempt 1: Use Admin Credentials via makeAdminApiRequest ---
    if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
      console.error(`[API] Attempt 1: Updating entry ${id} for ${contentType} using makeAdminApiRequest`);
      try {
        // Admin API for content management often uses a different path structure
        // Build endpoint with correct ID parameter
        const adminEndpoint = IdParameterHandler.buildEndpoint(`/content-manager/collection-types/${contentType}`, id, contentType);
        console.error(`[API] Trying admin update endpoint: ${adminEndpoint}`);
        
        // Admin API PUT might just need the data directly, not nested under 'data'
        const adminResponse = await makeAdminApiRequest(adminEndpoint, 'put', data); // Send 'data' directly

        // Check response from admin API (structure might differ)
        if (adminResponse) {
          console.error(`[API] Successfully updated entry ${id} via makeAdminApiRequest.`);
          // Admin API might return the updated entry directly or nested under 'data'
          return adminResponse.data || adminResponse; 
        } else {
          // Should not happen if makeAdminApiRequest resolves, but handle defensively
          console.warn(`[API] Admin update for ${id} completed but returned no data.`);
          // Return a success indicator even without data, as the operation likely succeeded
          return { id: id, message: "Update via admin succeeded, no data returned." }; 
        }
      } catch (adminError) {
        console.error(`[API] Failed to update entry ${id} using admin credentials:`, adminError);
        console.error(`[API] Admin credentials failed, attempting to use API token as fallback.`);
      }
    } else {
      console.error("[API] Admin credentials not provided, falling back to API token.");
    }

    // --- Attempt 2: Use API Token via strapiClient (as fallback) ---
    console.error(`[API] Attempt 2: Updating entry ${id} for ${contentType} using strapiClient`);
    
    // Build endpoint with correct ID parameter
    const apiEndpoint = IdParameterHandler.buildEndpoint(`/api/${collection}`, id, contentType);
    
    const response = await strapiClient.put(apiEndpoint, { data: data });
    
    // Check if data was returned
    if (response.data && response.data.data) {
      console.error(`[API] Successfully updated entry ${id} via strapiClient.`);
      return response.data.data; // Success with data returned
    } else {
      // Update might have succeeded but didn't return data
      console.warn(`[API] Update via strapiClient for ${id} completed, but no updated data returned.`);
      // Return a success indicator even without data, as the operation likely succeeded
      return { id: id, message: "Update via API token succeeded, no data returned." };
    }
  } catch (error) {
    console.error(`[API] Failed to update entry ${id} via strapiClient:`, error);
    
    // Re-throw McpError as is
    if (error instanceof McpError) {
      throw error;
    }
    
    // Handle ID-related errors
    const handledError = IdErrorHandler.handleIdError(error, id, contentType);
    if (handledError !== error) {
      throw handledError;
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to update entry ${id} for ${contentType}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Delete an entry
 */
async function deleteEntry(contentType: string, id: string): Promise<void> {
  try {
    console.error(`[API] Deleting entry ${id} for content type: ${contentType}`);
    
    // Extract the collection name from the content type UID
    const collection = contentType.split(".")[1];
    
    // --- Attempt 1: Use Admin Credentials if available ---
    if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
      console.error(`[API] Attempting to delete entry ${id} using admin credentials`);
      try {
        // Strapi v5 admin API endpoint for deleting entries - use IdParameterHandler
        const adminEndpoint = IdParameterHandler.buildEndpoint(`/content-manager/collection-types/${contentType}`, id, contentType);
        console.error(`[API] Admin endpoint: ${adminEndpoint}`);
        
        const response = await makeAdminApiRequest(adminEndpoint, 'DELETE');
        console.error(`[API] ✓ Successfully deleted entry ${id} via Admin API`);
        return;
      } catch (adminError) {
        console.error(`[API] Admin API delete failed:`, adminError);
        // Continue to try Content API
      }
    }
    
    // --- Attempt 2: Use Content API with API Token ---
    if (STRAPI_API_TOKEN) {
      console.error(`[API] Attempting to delete entry ${id} using API token`);
      try {
        // Build endpoint with correct ID parameter
        const endpoint = IdParameterHandler.buildEndpoint(`/api/${collection}`, id, contentType);
        console.error(`[API] Content API endpoint: ${endpoint}`);
        
        // Delete the entry from Strapi
        await strapiClient.delete(endpoint);
        console.error(`[API] ✓ Successfully deleted entry ${id} via Content API`);
        return;
      } catch (tokenError) {
        console.error(`[API] Content API delete failed:`, tokenError);
        throw tokenError;
      }
    }
    
    throw new Error('No valid authentication method available for deleting entries');
    
  } catch (error) {
    console.error(`[Error] Failed to delete entry ${id} for ${contentType}:`, error);
    
    // Handle ID-related errors
    const handledError = IdErrorHandler.handleIdError(error, id, contentType);
    if (handledError !== error) {
      throw handledError;
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to delete entry ${id} for ${contentType}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Upload media file to Strapi
 */
async function uploadMedia(fileData: string, fileName: string, fileType: string): Promise<any> {
  try {
    console.error(`[API] Uploading media file: ${fileName} (type: ${fileType})`);
    
    // Calculate base64 size and warn about large files
    const base64Size = fileData.length;
    const estimatedFileSize = Math.round((base64Size * 3) / 4); // Rough file size estimate
    const estimatedFileSizeMB = (estimatedFileSize / (1024 * 1024)).toFixed(2);
    
    console.error(`[API] File size: ~${estimatedFileSizeMB}MB (base64 length: ${base64Size})`);
    
    // Add size limits to prevent context window overflow
    const MAX_BASE64_SIZE = 1024 * 1024; // 1MB of base64 text (~750KB file)
    if (base64Size > MAX_BASE64_SIZE) {
      const maxFileSizeMB = ((MAX_BASE64_SIZE * 3) / 4 / (1024 * 1024)).toFixed(2);
      throw new Error(`File too large. Base64 data is ${base64Size} characters (~${estimatedFileSizeMB}MB file). Maximum allowed is ${MAX_BASE64_SIZE} characters (~${maxFileSizeMB}MB file). Large files cause context window overflow. Consider using smaller files or implementing chunked upload.`);
    }
    
    // Warn about large files that might cause issues
    if (base64Size > 100000) { // 100KB of base64 text
      console.error(`[API] Warning: Large file detected (~${estimatedFileSizeMB}MB). This may cause context window issues.`);
    }
    
    // Strapi v5: Direct buffer upload to /api/upload endpoint
    console.error(`[API] Converting base64 to buffer for direct upload`);
    
    const buffer = Buffer.from(fileData, 'base64');
    
    // Use form-data for multipart/form-data request (same as uploadMediaFromPath)
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    
    // Append buffer directly with proper options
    form.append('files', buffer, {
      filename: fileName,
      contentType: fileType
    });
    
    console.error(`[API] Uploading to /api/upload endpoint (Strapi v5)`);
    
    // Make request directly to upload endpoint (no authentication needed for file upload)
    const response = await strapiClient.post('/api/upload', form, {
      headers: {
        ...form.getHeaders(), // Get proper multipart headers
      }
    });
    
    // Filter out any base64 data from the response to prevent context overflow
    const cleanResponse = filterBase64FromResponse(response.data);
    
    return cleanResponse;
  } catch (error) {
    console.error(`[Error] Failed to upload media file ${fileName}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to upload media file ${fileName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Find folder by name in Strapi Media Library
 */
async function findFolder(folderName: string): Promise<any | null> {
  try {
    console.error(`[API] Searching for folder: ${folderName}`);
    
    // Ensure we have authenticated if required
    if (!await ensureAuthenticated()) {
      throw new Error('Authentication required');
    }
    
    // Make request to get folders
    const response = await makeRequest('/upload/folders', {
      method: 'GET',
      params: {
        'filters[name][$eq]': folderName,
        'pagination[limit]': 1
      }
    });
    
    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      console.error(`[API] Found existing folder: ${folderName} (ID: ${response.data[0].id})`);
      return response.data[0];
    }
    
    return null;
  } catch (error) {
    console.error(`[API] Error searching for folder ${folderName}:`, error);
    return null;
  }
}

/**
 * Create a new folder in Strapi Media Library
 */
async function createFolder(folderName: string, parentId: number | null = null): Promise<any> {
  try {
    console.error(`[API] Creating folder: ${folderName}`);
    
    // Ensure we have authenticated if required
    if (!await ensureAuthenticated()) {
      throw new Error('Authentication required');
    }
    
    // Prepare folder data
    const folderData = {
      name: folderName,
      parent: parentId
    };
    
    console.error(`[API] Folder data:`, folderData);
    
    // Create folder via admin API
    const response = await makeRequest('/upload/folders/', {
      method: 'POST',
      data: folderData
    });
    
    if (response.data) {
      console.error(`[API] Successfully created folder: ${folderName} (ID: ${response.data.id})`);
      return response.data;
    } else {
      throw new Error('Failed to create folder - no data returned');
    }
  } catch (error) {
    console.error(`[API] Error creating folder ${folderName}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to create folder ${folderName}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get folder ID by name (create if doesn't exist)
 */
async function getFolderId(folderName: string): Promise<number | null> {
  try {
    // First try to find existing folder
    let folder = await findFolder(folderName);
    
    if (!folder) {
      console.error(`[API] Folder '${folderName}' not found, creating new folder`);
      folder = await createFolder(folderName);
    }
    
    return folder?.id || null;
  } catch (error) {
    console.error(`[API] Error getting folder ID for ${folderName}:`, error);
    throw error;
  }
}

/**
 * Upload media file from file path (alternative to base64) with folder support
 */
async function uploadMediaFromPath(filePath: string, fileName?: string, fileType?: string, folderName?: string): Promise<any> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    // Get file stats
    const stats = fs.statSync(filePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.error(`[API] Uploading media file from path: ${filePath} (${fileSizeMB}MB)`);
    
    // Add size limits
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${fileSizeMB}MB. Maximum allowed is 10MB.`);
    }
    
    // Auto-detect fileName and fileType if not provided
    const actualFileName = fileName || path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    
    let actualFileType = fileType;
    if (!actualFileType) {
      // Basic MIME type detection
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.mp4': 'video/mp4',
        '.avi': 'video/avi',
        '.mov': 'video/quicktime'
      };
      actualFileType = mimeTypes[extension] || 'application/octet-stream';
    }
    
    // Handle folder logic if folderName is provided
    let folderId: number | null = null;
    if (folderName) {
      console.error(`[API] Processing folder: ${folderName}`);
      try {
        folderId = await getFolderId(folderName);
        console.error(`[API] Using folder ID: ${folderId}`);
      } catch (folderError) {
        console.error(`[API] Warning: Failed to create/find folder ${folderName}:`, folderError);
        console.error(`[API] Continuing with upload to root folder...`);
      }
    }
    
    // Strapi v5: Direct file upload to /upload endpoint with folder support
    console.error(`[API] Reading file buffer for direct upload: ${filePath}`);
    
    // Read file as buffer (no base64 conversion needed)
    const fileBuffer = fs.readFileSync(filePath);
    
    // Use form-data for multipart/form-data request
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    
    // Append file buffer directly with proper options
    form.append('files', fileBuffer, {
      filename: actualFileName,
      contentType: actualFileType
    });
    
    // Add file info with folder metadata (Strapi v5 format)
    const fileInfo: any = {
      name: actualFileName,
      caption: '',
      alternativeText: ''
    };
    
    // Add folder ID if available - try multiple approaches for compatibility
    if (folderId) {
      // Method 1: Add folder to fileInfo (recommended for Strapi v5)
      fileInfo.folder = folderId;
      
      // Method 2: Direct form parameters (fallback)
      form.append('folder', folderId.toString());
      form.append('folderId', folderId.toString());
      
      console.error(`[API] Adding folder ID to upload: ${folderId} (using fileInfo.folder + form parameters)`);
    }
    
    // Add fileInfo as JSON string
    form.append('fileInfo', JSON.stringify(fileInfo));
    console.error(`[API] FileInfo metadata:`, JSON.stringify(fileInfo, null, 2));
    
    console.error(`[API] Uploading to /upload endpoint (Strapi v5) ${folderId ? `with folder ID ${folderId}` : 'to root folder'}`);
    console.error(`[API] Form data fields:`, Object.keys(form.getHeaders()));
    
    // Ensure we have authentication for file upload
    if (!await ensureAuthenticated()) {
      throw new Error('Authentication required for file upload');
    }
    
    // Make request to upload endpoint using makeRequest for proper authentication
    const response = await makeRequest('/upload', {
      method: 'POST',
      data: form,
      headers: {
        ...form.getHeaders(), // Get proper multipart headers
      }
    });
    
    console.error(`[API] ✅ File upload successful`);
    console.error(`[API] Upload response:`, JSON.stringify(response, null, 2));
    
    // Check if files were uploaded to the correct folder
    if (response && Array.isArray(response) && response.length > 0) {
      const uploadedFile = response[0];
      if (uploadedFile.folder || uploadedFile.folderId) {
        console.error(`[API] ✅ File uploaded to folder:`, uploadedFile.folder || uploadedFile.folderId);
      } else if (folderId) {
        console.error(`[API] ⚠️ Warning: Folder ID was specified (${folderId}) but uploaded file doesn't show folder info`);
      }
    }
    
    // Filter out any base64 data from the response to prevent context overflow
    const cleanResponse = filterBase64FromResponse(response);
    return cleanResponse;
    
  } catch (error) {
    console.error(`[Error] Failed to upload media file from path ${filePath}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to upload media file from path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Filter base64 data from API responses to prevent context overflow
 */
function filterBase64FromResponse(data: any): any {
  if (!data) return data;
  
  // If it's an array, filter each item
  if (Array.isArray(data)) {
    return data.map(item => filterBase64FromResponse(item));
  }
  
  // If it's an object, process each property
  if (typeof data === 'object') {
    const filtered: any = {};
    
    for (const [key, value] of Object.entries(data)) {
      // Skip or truncate fields that might contain base64 data
      if (typeof value === 'string') {
        // Check if this looks like base64 data (long string, mostly alphanumeric with +/=)
        if (value.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(value.substring(0, 100))) {
          filtered[key] = `[BASE64_DATA_FILTERED - ${value.length} chars]`;
        } else {
          filtered[key] = value;
        }
      } else {
        filtered[key] = filterBase64FromResponse(value);
      }
    }
    
    return filtered;
  }
  
  return data;
}

/**
 * Fetch the schema for a specific content type
 */
 async function fetchContentTypeSchema(contentType: string): Promise<any> {
   try {
     console.error(`[API] Fetching schema for content type: ${contentType}`);
 
     // --- Attempt 1: Use Admin Credentials if available ---
     if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
       console.error("[API] Attempting to fetch schema using admin credentials");
       try {
         const endpoint = `/content-type-builder/content-types/${contentType}`;
         console.error(`[API] Trying admin endpoint: ${endpoint}`);
         const adminResponse = await makeAdminApiRequest(endpoint);
 
         // Check for schema data (often nested under 'data')
         if (adminResponse && adminResponse.data) {
            console.error("[API] Successfully fetched schema via Admin API");
            return adminResponse.data; // Return the schema data
         } else {
            console.error("[API] Admin API response for schema did not contain expected data.", adminResponse);
         }
       } catch (adminError) {
         console.error(`[API] Failed to fetch schema using admin credentials:`, adminError);
         // Don't throw, proceed to next method if it was a 404 or auth error
         if (!(axios.isAxiosError(adminError) && (adminError.response?.status === 401 || adminError.response?.status === 403 || adminError.response?.status === 404))) {
            throw adminError; // Rethrow unexpected errors
         }
       }
     } else {
        console.error("[API] Admin credentials not provided, skipping admin API attempt for schema.");
     }
 
     // --- Attempt 2: Infer schema from public API (Fallback) ---
     console.error("[API] Attempting to infer schema from public API");

    // Extract the collection name from the content type UID
    const collection = contentType.split(".")[1];
    
    // Try to get a sample entry to infer the schema
    try {
      // Try multiple possible API paths
      const possiblePaths = [
        `/api/${collection}`,
        `/api/${collection.toLowerCase()}`,
        `/api/v1/${collection}`,
        `/${collection}`,
        `/${collection.toLowerCase()}`
      ];
      
      let response;
      let success = false;
      
      // Try each path until one works
      for (const path of possiblePaths) {
        try {
          console.error(`[API] Trying path for schema inference: ${path}`);
          // Request with small limit to minimize data transfer
          response = await strapiClient.get(`${path}?pagination[limit]=1&pagination[page]=1`);
          console.error(`[API] Successfully fetched sample data from: ${path}`);
          success = true;
          break;
        } catch (err: any) {
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            // Continue to try the next path if not found
            continue;
          }
          // For other errors, throw immediately
          throw err;
        }
      }
      
      if (!success || !response) {
        throw new Error(`Could not find any valid API path for ${collection}`);
      }
      
      // Extract a sample entry to infer schema
      let sampleEntry;
      if (response.data.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
        // Standard Strapi v4 response
        sampleEntry = response.data.data[0];
      } else if (Array.isArray(response.data) && response.data.length > 0) {
        // Array response
        sampleEntry = response.data[0];
      } else if (response.data) {
        // Object response
        sampleEntry = response.data;
      }
      
      if (!sampleEntry) {
        throw new Error(`No sample entries available to infer schema for ${contentType}`);
      }
      
      // Infer schema from sample entry
      const attributes: Record<string, any> = {};
      
      // Process entry to infer attribute types
      Object.entries(sampleEntry.attributes || sampleEntry).forEach(([key, value]) => {
        if (key === 'id') return; // Skip ID field
        
        let type: string = typeof value;
        
        if (type === 'object') {
          if (value === null) {
            type = 'string'; // Assume nullable string
          } else if (Array.isArray(value)) {
            type = 'relation'; // Assume array is a relation
          } else if (value instanceof Date) {
            type = 'datetime';
          } else {
            type = 'json'; // Complex object
          }
        }
        
        attributes[key] = { type };
      });
      
      // Return inferred schema
      return {
        uid: contentType,
        apiID: collection,
        info: {
          displayName: collection.charAt(0).toUpperCase() + collection.slice(1),
          description: `Inferred schema for ${collection}`,
        },
        attributes
      };
      
    } catch (inferError) {
      console.error(`[API] Failed to infer schema:`, inferError);
      
      // Return a minimal schema as fallback
      return {
        uid: contentType,
        apiID: collection,
        info: {
          displayName: collection.charAt(0).toUpperCase() + collection.slice(1),
          description: `${collection} content type`,
        },
        attributes: {}
      };
    }
  } catch (error: any) {
    let errorMessage = `Failed to fetch schema for ${contentType}`;
    let errorCode = ExtendedErrorCode.InternalError;

    if (axios.isAxiosError(error)) {
      errorMessage += `: ${error.response?.status} ${error.response?.statusText}`;
      if (error.response?.status === 404) {
        errorCode = ExtendedErrorCode.ResourceNotFound;
        errorMessage += ` (Content type not found)`;
      } else if (error.response?.status === 403) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Permission denied - check API token permissions for Content-Type Builder)`;
      } else if (error.response?.status === 401) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Unauthorized - API token may be invalid or expired)`;
      } else if (error.response?.status === 400) {
        errorCode = ExtendedErrorCode.InvalidRequest;
        errorMessage += ` (Bad request - malformed content type ID)`;
      }
    } else if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
    } else {
      errorMessage += `: ${String(error)}`;
    }

    console.error(`[Error] ${errorMessage}`);
    throw new ExtendedMcpError(errorCode, errorMessage);
  }
}

/**
 * Connect related entries for a specific field
 */
async function connectRelation(contentType: string, id: string, relationField: string, relatedIds: number[] | string[]): Promise<any> {
  try {
    console.error(`[API] Connecting relations for ${contentType} ${id}, field ${relationField}`);
    
    // Transform related IDs based on version
    const transformedRelatedIds = relatedIds.map(relatedId => {
      const { value } = IdParameterHandler.resolveIdParameter(relatedId.toString(), relationField);
      return { id: Number(value) }; // For v4 compatibility, ensure IDs are numbers
    });
    
    const updateData = {
      data: { // Strapi v4 expects relation updates within the 'data' object for PUT
        [relationField]: {
          connect: transformedRelatedIds
        }
      }
    };
    // Reuse updateEntry logic which correctly wraps payload in { data: ... }
    return await updateEntry(contentType, id, updateData.data); 
  } catch (error) {
    // Rethrow McpError or wrap others
    if (error instanceof McpError) throw error;
    console.error(`[Error] Failed to connect relation ${relationField} for ${contentType} ${id}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to connect relation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Disconnect related entries for a specific field
 */
async function disconnectRelation(contentType: string, id: string, relationField: string, relatedIds: number[] | string[]): Promise<any> {
  try {
    console.error(`[API] Disconnecting relations for ${contentType} ${id}, field ${relationField}`);
    
    // Transform related IDs based on version
    const transformedRelatedIds = relatedIds.map(relatedId => {
      const { value } = IdParameterHandler.resolveIdParameter(relatedId.toString(), relationField);
      return { id: Number(value) }; // For v4 compatibility, ensure IDs are numbers
    });
    
    const updateData = {
      data: { // Strapi v4 expects relation updates within the 'data' object for PUT
        [relationField]: {
          disconnect: transformedRelatedIds
        }
      }
    };
    // Reuse updateEntry logic which correctly wraps payload in { data: ... }
    return await updateEntry(contentType, id, updateData.data); 

  } catch (error) {
     // Rethrow McpError or wrap others
     if (error instanceof McpError) throw error;
    console.error(`[Error] Failed to disconnect relation ${relationField} for ${contentType} ${id}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to disconnect relation: ${error instanceof Error ? error.message : String(error)}`
   );
 }
 }
 
 /**
  * Update an existing content type in Strapi. Requires admin privileges.
  */
 async function updateContentType(contentTypeUid: string, attributesToUpdate: Record<string, any>): Promise<any> {
   try {
     console.error(`[API] Updating content type: ${contentTypeUid}`);
 
     if (!contentTypeUid || !attributesToUpdate || typeof attributesToUpdate !== 'object') {
       throw new Error("Missing required fields: contentTypeUid, attributesToUpdate (object)");
     }
 
     // 1. Fetch the current schema
     console.error(`[API] Fetching current schema for ${contentTypeUid}`);
     // Use fetchContentTypeSchema which already tries admin endpoint first
     const currentSchemaData = await fetchContentTypeSchema(contentTypeUid);
 
     // Ensure we have the schema structure (might be nested under 'schema')
     let currentSchema = currentSchemaData.schema || currentSchemaData;
     if (!currentSchema || !currentSchema.attributes) {
         // If schema is still not found or malformed after fetchContentTypeSchema tried, error out
          console.error("[API] Could not retrieve a valid current schema structure.", currentSchemaData);
          throw new Error(`Could not retrieve a valid schema structure for ${contentTypeUid}`);
     }
     console.error(`[API] Current attributes: ${Object.keys(currentSchema.attributes).join(', ')}`);
 
 
     // 2. Merge new/updated attributes into the current schema's attributes
     const updatedAttributes = { ...currentSchema.attributes, ...attributesToUpdate };
     console.error(`[API] Attributes after update: ${Object.keys(updatedAttributes).join(', ')}`);
 
 
     // 3. Construct the payload for the PUT request
     // Strapi's PUT endpoint expects the *entire* content type definition under the 'contentType' key,
     // and potentially component updates under 'components'. We only update contentType here.
     const payload = {
       contentType: {
         ...currentSchema, // Spread the existing schema details
         attributes: updatedAttributes // Use the merged attributes
       }
       // If components needed updating, add a 'components: [...]' key here
     };
 
     // Remove potentially problematic fields if they exist at the top level of currentSchema
     // These are often managed internally by Strapi
     delete payload.contentType.uid; // UID is usually in the URL, not body for PUT
     // delete payload.contentType.schema; // If schema was nested, remove the outer key
 
 
     console.error(`[API] Update Payload for PUT /content-type-builder/content-types/${contentTypeUid}: ${JSON.stringify(payload, null, 2)}`);
 
     // 4. Make the PUT request using admin credentials
     const endpoint = `/content-type-builder/content-types/${contentTypeUid}`;
     const response = await makeAdminApiRequest(endpoint, 'put', payload);
 
     console.error(`[API] Content type update response:`, response);
 
     // Response might vary, often includes the updated UID or a success message
     return response?.data || { message: `Content type ${contentTypeUid} update initiated. Strapi might be restarting.` };
 
   } catch (error: any) {
     console.error(`[Error] Failed to update content type ${contentTypeUid}:`, error);
 
     let errorMessage = `Failed to update content type ${contentTypeUid}`;
     let errorCode = ExtendedErrorCode.InternalError;
 
     if (axios.isAxiosError(error)) {
       errorMessage += `: ${error.response?.status} ${error.response?.statusText}`;
       const responseData = JSON.stringify(error.response?.data);
       if (error.response?.status === 400) {
          errorCode = ExtendedErrorCode.InvalidParams;
          errorMessage += ` (Bad Request - Check payload/attributes): ${responseData}`;
       } else if (error.response?.status === 404) {
          errorCode = ExtendedErrorCode.ResourceNotFound;
          errorMessage += ` (Content Type Not Found)`;
       } else if (error.response?.status === 403 || error.response?.status === 401) {
          errorCode = ExtendedErrorCode.AccessDenied;
          errorMessage += ` (Permission Denied - Admin credentials might lack permissions): ${responseData}`;
       } else {
          errorMessage += `: ${responseData}`;
       }
     } else if (error instanceof Error) {
       errorMessage += `: ${error.message}`;
     } else {
       errorMessage += `: ${String(error)}`;
     }
 
     throw new ExtendedMcpError(errorCode, errorMessage);
   }
 }
 
 
 /**
  * Create a new content type in Strapi. Requires admin privileges.
  */
 async function createContentType(contentTypeData: any): Promise<any> {
   try {
     const { displayName, singularName, pluralName, kind = 'collectionType', attributes, draftAndPublish = true, description = "" } = contentTypeData;
 
     if (!displayName || !singularName || !pluralName || !attributes) {
       throw new Error("Missing required fields: displayName, singularName, pluralName, attributes");
     }
 
     // Construct the payload for the Content-Type Builder API
     // Ensure API IDs are Strapi-compliant (lowercase, no spaces, etc.)
     const singularApiId = singularName.toLowerCase().replace(/\s+/g, '-');
     const pluralApiId = pluralName.toLowerCase().replace(/\s+/g, '-');
     const collectionName = pluralName.toLowerCase().replace(/\s+/g, '_'); // Table name often uses underscores
     
     // For Strapi v4, the primary difference is in the nesting structure
     // The data should be formatted exactly like in the Strapi UI
     const payload = {
       contentType: {
         displayName: displayName,
         singularName: singularApiId,
         pluralName: pluralApiId,
         description: description,
         kind: kind,
         collectionName: collectionName,
         options: {
           draftAndPublish: draftAndPublish
         },
         pluginOptions: {},
         attributes: typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {}
       }
     };
 
     console.error(`[API] Creating new content type: ${displayName}`);
     console.error(`[API] Attempting to create content type with payload: ${JSON.stringify(payload, null, 2)}`);
     
     // Make sure we're using the correct Content-Type Builder endpoint
     // This is the documented endpoint for Strapi v4
     const endpoint = '/content-type-builder/content-types';
     console.error(`[API] Using endpoint: ${endpoint}`);
     
     try {
       const response = await makeAdminApiRequest(endpoint, 'post', payload);
       console.error(`[API] Raw response from makeAdminApiRequest (createContentType):`, response); 
     
       console.error(`[API] Content type creation response:`, response);
     
       // Strapi might restart after schema changes, response might vary
       // Often returns { data: { uid: 'api::...' } } or similar on success
       return response?.data || { message: "Content type creation initiated. Strapi might be restarting." };
     } catch (apiError) {
       console.error(`[API] CRITICAL ERROR in makeAdminApiRequest call:`, apiError);
       
       if (axios.isAxiosError(apiError) && apiError.response) {
         // Log the complete error details for debugging
         console.error(`[API] Status Code: ${apiError.response.status}`);
         console.error(`[API] Status Text: ${apiError.response.statusText}`);
         console.error(`[API] Response Headers:`, apiError.response.headers);
         console.error(`[API] DETAILED ERROR PAYLOAD:`, JSON.stringify(apiError.response.data, null, 2));
         
         // Check for specific error messages from Strapi that indicate payload issues
         if (apiError.response.status === 400) {
           const errorData = apiError.response.data;
           console.error(`[API] 400 BAD REQUEST - Payload validation error`);
           
           // Extract and log specific validation errors
           if (errorData.error && errorData.message) {
             console.error(`[API] Error Type: ${errorData.error}`);
             console.error(`[API] Error Message: ${errorData.message}`);
           }
           
           // Log any validation details
           if (errorData.data && errorData.data.errors) {
             console.error(`[API] Validation Errors:`, JSON.stringify(errorData.data.errors, null, 2));
           }
         }
       }
       throw apiError; // Re-throw to be caught by outer catch
     }
   } catch (error: any) {
     console.error(`[Error RAW] createContentType caught error:`, error); 
     if (axios.isAxiosError(error) && error.response) {
       console.error(`[Error DETAIL] Strapi error response data (createContentType): ${JSON.stringify(error.response.data)}`);
       console.error(`[Error DETAIL] Strapi error response status (createContentType): ${error.response.status}`);
       console.error(`[Error DETAIL] Strapi error response headers (createContentType): ${JSON.stringify(error.response.headers)}`);
     }
     console.error(`[Error] Failed to create content type:`, error); // This line was already there, keeping it for context
 
     let errorMessage = `Failed to create content type`;
     let errorCode = ExtendedErrorCode.InternalError;
 
     if (axios.isAxiosError(error)) {
       errorMessage += `: ${error.response?.status} ${error.response?.statusText}`;
       if (error.response?.status === 400) {
          errorCode = ExtendedErrorCode.InvalidParams;
          errorMessage += ` (Bad Request - Check payload format/names): ${JSON.stringify(error.response?.data)}`;
       } else if (error.response?.status === 403 || error.response?.status === 401) {
          errorCode = ExtendedErrorCode.AccessDenied;
          errorMessage += ` (Permission Denied - Admin credentials might lack permissions)`;
       }
     } else if (error instanceof Error) {
       errorMessage += `: ${error.message}`;
     } else {
       errorMessage += `: ${String(error)}`;
     }
 
     throw new ExtendedMcpError(errorCode, errorMessage);
   }
 }
 
 /**
  * Publish an entry
  */
 async function publishEntry(contentType: string, id: string): Promise<any> {
   try {
     console.error(`[API] Publishing entry ${id} for content type: ${contentType}`);
     
     // Resolve real documentId if integer ID is provided
     let resolvedId = id;
     if (detectedStrapiVersion === 'v5' && /^\d+$/.test(id)) {
       console.error(`[API] Integer ID detected for v5, resolving to documentId...`);
       try {
         const collection = contentType.split(".")[1];
         const response = await strapiClient.get(`/api/${collection}`, {
           params: {
             'filters[id][$eq]': id,
             'pagination[limit]': 1
           }
         });
         
         if (response.data?.data?.[0]?.documentId) {
           resolvedId = response.data.data[0].documentId;
           console.error(`[API] Resolved ID ${id} to documentId: ${resolvedId}`);
         } else {
           console.error(`[API] Could not resolve ID ${id} to documentId, using original ID`);
         }
       } catch (resolveError) {
         console.error(`[API] Failed to resolve ID ${id} to documentId:`, resolveError);
         // Continue with original ID
       }
     }
     
     // --- Attempt 1: Use Admin Credentials ---
     if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
       console.error(`[API] Attempt 1: Publishing entry ${resolvedId} for ${contentType} using admin credentials`);
       try {
         // The admin API endpoint for publishing - build with correct ID parameter
         const adminEndpoint = IdParameterHandler.buildEndpoint(`/content-manager/collection-types/${contentType}`, resolvedId, contentType) + '/actions/publish';
         
         // Make the POST request to publish
         const adminResponse = await makeAdminApiRequest(adminEndpoint, 'post');
         
         if (adminResponse) {
           console.error(`[API] Successfully published entry ${resolvedId} via admin credentials`);
           return adminResponse;
         }
       } catch (adminError) {
         console.error(`[API] Failed to publish entry ${resolvedId} using admin credentials:`, adminError);
         console.error(`[API] Falling back to API token...`);
       }
     } else {
       console.error(`[API] Admin credentials not provided, falling back to API token`);
     }
     
     // --- Attempt 2: Use API Token (fallback) - update the publishedAt field directly ---
     const collection = contentType.split(".")[1];
     console.error(`[API] Attempt 2: Publishing entry ${resolvedId} for ${contentType} using API token`);
     
     // Build endpoint with correct ID parameter
     const apiEndpoint = IdParameterHandler.buildEndpoint(`/api/${collection}`, resolvedId, contentType);
     
     // For API token, we'll update the publishedAt field to the current time
     const now = new Date().toISOString();
     const response = await strapiClient.put(apiEndpoint, {
       data: {
         publishedAt: now
       }
     });
     
     return response.data.data;
   } catch (error) {
     console.error(`[Error] Failed to publish entry ${id} for ${contentType}:`, error);
     
     // Handle ID-related errors
     const handledError = IdErrorHandler.handleIdError(error, id, contentType);
     if (handledError !== error) {
       throw handledError;
     }
     
     throw new McpError(
       ErrorCode.InternalError,
       `Failed to publish entry ${id} for ${contentType}: ${error instanceof Error ? error.message : String(error)}`
     );
   }
 }

 /**
  * Unpublish an entry
  */
 async function unpublishEntry(contentType: string, id: string): Promise<any> {
   try {
     console.error(`[API] Unpublishing entry ${id} for content type: ${contentType}`);
     
     // --- Attempt 1: Use Admin Credentials ---
     if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
       console.error(`[API] Attempt 1: Unpublishing entry ${id} for ${contentType} using admin credentials`);
       try {
         // The admin API endpoint for unpublishing - build with correct ID parameter
         const adminEndpoint = IdParameterHandler.buildEndpoint(`/content-manager/collection-types/${contentType}`, id, contentType) + '/actions/unpublish';
         
         // Make the POST request to unpublish
         const adminResponse = await makeAdminApiRequest(adminEndpoint, 'post');
         
         if (adminResponse) {
           console.error(`[API] Successfully unpublished entry ${id} via admin credentials`);
           return adminResponse;
         }
       } catch (adminError) {
         console.error(`[API] Failed to unpublish entry ${id} using admin credentials:`, adminError);
         console.error(`[API] Falling back to API token...`);
       }
     } else {
       console.error(`[API] Admin credentials not provided, falling back to API token`);
     }
     
     // --- Attempt 2: Use API Token (fallback) - set publishedAt to null ---
     const collection = contentType.split(".")[1];
     console.error(`[API] Attempt 2: Unpublishing entry ${id} for ${contentType} using API token`);
     
     // Build endpoint with correct ID parameter
     const apiEndpoint = IdParameterHandler.buildEndpoint(`/api/${collection}`, id, contentType);
     
     // For API token, we'll set the publishedAt field to null
     const response = await strapiClient.put(apiEndpoint, {
       data: {
         publishedAt: null
       }
     });
     
     return response.data.data;
   } catch (error) {
     console.error(`[Error] Failed to unpublish entry ${id} for ${contentType}:`, error);
     
     // Handle ID-related errors
     const handledError = IdErrorHandler.handleIdError(error, id, contentType);
     if (handledError !== error) {
       throw handledError;
     }
     
     throw new McpError(
       ErrorCode.InternalError,
       `Failed to unpublish entry ${id} for ${contentType}: ${error instanceof Error ? error.message : String(error)}`
     );
   }
 }

 /**
  * List all components
  */
 async function listComponents(): Promise<any[]> {
   try {
     console.error(`[API] Listing all components`);
     
     // Admin credentials are required for component operations
     if (!STRAPI_ADMIN_EMAIL || !STRAPI_ADMIN_PASSWORD) {
       throw new ExtendedMcpError(
         ExtendedErrorCode.AccessDenied,
         "Admin credentials are required for component operations"
       );
     }
     
     // The admin API endpoint for components
     const adminEndpoint = `/content-type-builder/components`;
     
     // Make the GET request to fetch components
     const componentsResponse = await makeAdminApiRequest(adminEndpoint);
     
     if (!componentsResponse || !componentsResponse.data) {
       console.error(`[API] No components found or unexpected response format`);
       return [];
     }
     
     // Process the components data
     const components = Array.isArray(componentsResponse.data) 
       ? componentsResponse.data 
       : [componentsResponse.data];
     
     // Return formatted component info
     return components.map((component: any) => ({
       uid: component.uid,
       category: component.category,
       displayName: component.info?.displayName || component.uid.split('.').pop(),
       description: component.info?.description || `${component.uid} component`,
       icon: component.info?.icon
     }));
   } catch (error) {
     console.error(`[Error] Failed to list components:`, error);
     throw new McpError(
       ErrorCode.InternalError,
       `Failed to list components: ${error instanceof Error ? error.message : String(error)}`
     );
   }
 }

 /**
  * Get component schema
  */
 async function getComponentSchema(componentUid: string): Promise<any> {
   try {
     console.error(`[API] Fetching schema for component: ${componentUid}`);
     
     // Admin credentials are required for component operations
     if (!STRAPI_ADMIN_EMAIL || !STRAPI_ADMIN_PASSWORD) {
       throw new ExtendedMcpError(
         ExtendedErrorCode.AccessDenied,
         "Admin credentials are required for component operations"
       );
     }
     
     // The admin API endpoint for a specific component
     const adminEndpoint = `/content-type-builder/components/${componentUid}`;
     
     // Make the GET request to fetch the component schema
     const componentResponse = await makeAdminApiRequest(adminEndpoint);
     
     if (!componentResponse || !componentResponse.data) {
       throw new ExtendedMcpError(
         ExtendedErrorCode.ResourceNotFound,
         `Component ${componentUid} not found or access denied`
       );
     }
     
     return componentResponse.data;
   } catch (error) {
     console.error(`[Error] Failed to fetch component schema for ${componentUid}:`, error);
     throw new McpError(
       ErrorCode.InternalError,
       `Failed to fetch component schema for ${componentUid}: ${error instanceof Error ? error.message : String(error)}`
     );
   }
 }

 /**
  * Create a new component - Enhanced for Strapi v5
  */
 async function createComponent(componentData: any): Promise<any> {
   try {
     console.error(`[API] Creating new component (Strapi v5 enhanced)`);
     
     // Admin credentials are required for component operations
     if (!STRAPI_ADMIN_EMAIL || !STRAPI_ADMIN_PASSWORD) {
       throw new ExtendedMcpError(
         ExtendedErrorCode.AccessDenied,
         "Admin credentials are required for component operations"
       );
     }
     
     // Ensure we have authenticated before making request
     if (!await ensureAuthenticated()) {
       throw new Error('Authentication required for component creation');
     }
     
     const { displayName, category, icon, attributes, uid, apiId } = componentData;
     
     if (!displayName || !category || !attributes) {
       throw new Error("Missing required fields: displayName, category, attributes");
     }
     
     // Strapi v5 için doğru payload yapısı - create-component-script.js'deki gibi
     const payload = {
       component: {
         category: category,
         displayName: displayName,
         icon: icon || 'brush',
         attributes: attributes
       }
     };
     
     console.error(`[API] Component creation payload (v5):`, JSON.stringify(payload, null, 2));
     
     // Strapi v5 için doğru endpoint: /content-type-builder/components
     const adminEndpoint = `/content-type-builder/components`;
     console.error(`[API] Using admin endpoint: ${adminEndpoint}`);
     
     // Make the POST request to create the component with enhanced error handling
     try {
       const response = await makeAdminApiRequest(adminEndpoint, 'post', payload);
       
       console.error(`[API] ✅ Component created successfully!`);
       console.error(`[API] Response:`, response);
       
       // Response data processing
       if (response && response.data) {
         console.error(`[API] Created component:`, {
           uid: response.data.uid,
           category: response.data.category,
           displayName: response.data.displayName || response.data.schema?.displayName
         });
         return response.data;
       } else if (response) {
         // Response without nested data
         console.error(`[API] Created component (direct response):`, response);
         return response;
       } else {
         // Success but no response data
         console.error(`[API] Component creation completed successfully`);
         return { 
           message: "Component creation successful", 
           category: category,
           displayName: displayName 
         };
       }
       
     } catch (adminError) {
       console.error(`[API] ❌ Failed to create component:`, adminError);
       
       // Enhanced error reporting
       if (axios.isAxiosError(adminError)) {
         console.error(`[API] Status: ${adminError.response?.status}`);
         console.error(`[API] Response data:`, adminError.response?.data);
         
         // Specific error handling for component creation
         if (adminError.response?.status === 400) {
           const errorData = adminError.response.data;
           let errorMessage = `Invalid component data: ${adminError.response.statusText}`;
           
           if (errorData.error && errorData.error.message) {
             errorMessage += ` - ${errorData.error.message}`;
           }
           
           if (errorData.error && errorData.error.details) {
             errorMessage += ` - Details: ${JSON.stringify(errorData.error.details)}`;
           }
           
           throw new ExtendedMcpError(
             ExtendedErrorCode.InvalidParams,
             errorMessage
           );
         } else if (adminError.response?.status === 409) {
           throw new ExtendedMcpError(
             ExtendedErrorCode.InvalidParams,
             `Component already exists or conflicts with existing component`
           );
         } else if (adminError.response?.status === 401 || adminError.response?.status === 403) {
           throw new ExtendedMcpError(
             ExtendedErrorCode.AccessDenied,
             `Permission denied - Admin credentials might lack permissions for component creation`
           );
         }
       }
       
       throw adminError;
     }
     
   } catch (error) {
     console.error(`[Error] Failed to create component:`, error);
     
     // Re-throw ExtendedMcpError as is
     if (error instanceof ExtendedMcpError) {
       throw error;
     }
     
     // Wrap other errors
     throw new McpError(
       ErrorCode.InternalError,
       `Failed to create component: ${error instanceof Error ? error.message : String(error)}`
     );
   }
 }

 /**
  * Update an existing component
  */
 async function updateComponent(componentUid: string, attributesToUpdate: Record<string, any>): Promise<any> {
   try {
     console.error(`[API] Updating component: ${componentUid}`);
     
     // Admin credentials are required for component operations
     if (!STRAPI_ADMIN_EMAIL || !STRAPI_ADMIN_PASSWORD) {
       throw new ExtendedMcpError(
         ExtendedErrorCode.AccessDenied,
         "Admin credentials are required for component operations"
       );
     }
     
     // 1. Fetch the current component schema
     console.error(`[API] Fetching current schema for ${componentUid}`);
     const currentSchemaData = await getComponentSchema(componentUid);
     
     // Ensure we have the schema structure
     let currentSchema = currentSchemaData.schema || currentSchemaData;
     if (!currentSchema || !currentSchema.attributes) {
       console.error("[API] Could not retrieve a valid current schema structure.", currentSchemaData);
       throw new Error(`Could not retrieve a valid schema structure for ${componentUid}`);
     }
     
     // 2. Merge new/updated attributes into the current schema's attributes
     const updatedAttributes = { ...currentSchema.attributes, ...attributesToUpdate };
     
     // 3. Construct the payload for the PUT request
     const payload = {
       component: {
         ...currentSchema,
         attributes: updatedAttributes
       }
     };
     
     // Remove potentially problematic fields
     delete payload.component.uid;
     
     console.error(`[API] Component update payload:`, payload);
     
     // 4. Make the PUT request to update the component
     const adminEndpoint = `/content-type-builder/components/${componentUid}`;
     const response = await makeAdminApiRequest(adminEndpoint, 'put', payload);
     
     console.error(`[API] Component update response:`, response);
     
     // Response might vary, but should typically include the updated component data
     return response?.data || { message: `Component ${componentUid} update initiated. Strapi might be restarting.` };
   } catch (error) {
     console.error(`[Error] Failed to update component ${componentUid}:`, error);
     throw new McpError(
       ErrorCode.InternalError,
       `Failed to update component ${componentUid}: ${error instanceof Error ? error.message : String(error)}`
     );
   }
 }

/**
 * Handler for listing available Strapi content as resources.
 * Each content type and entry is exposed as a resource with:
 * - A strapi:// URI scheme
 * - JSON MIME type
 * - Human readable name and description
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    // Fetch all content types
    const contentTypes = await fetchContentTypes();
    
    // Create a resource for each content type
    const contentTypeResources = contentTypes.map(ct => ({
      uri: `strapi://content-type/${ct.uid}`,
      mimeType: "application/json",
      name: ct.info.displayName,
      description: `Strapi content type: ${ct.info.displayName}`
    }));
    
    // Return the resources
    return {
      resources: contentTypeResources
    };
  } catch (error) {
    console.error("[Error] Failed to list resources:", error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list resources: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

/**
 * Handler for reading the contents of a specific resource.
 * Takes a strapi:// URI and returns the content as JSON.
 * 
 * Supports URIs in the following formats:
 * - strapi://content-type/[contentTypeUid] - Get all entries for a content type
 * - strapi://content-type/[contentTypeUid]/[entryId] - Get a specific entry
 * - strapi://content-type/[contentTypeUid]?[queryParams] - Get filtered entries
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest) => {
  try {
    const uri = request.params.uri;
    
    // Parse the URI for content type
    const contentTypeMatch = uri.match(/^strapi:\/\/content-type\/([^\/\?]+)(?:\/([^\/\?]+))?(?:\?(.+))?$/);
    if (!contentTypeMatch) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Invalid URI format: ${uri}`
      );
    }
    
    const contentTypeUid = contentTypeMatch[1];
    const entryId = contentTypeMatch[2];
    const queryString = contentTypeMatch[3];
    
    // Parse query parameters if present
    let queryParams: QueryParams = {};
    if (queryString) {
      try {
        // Parse the query string into an object
        const parsedParams = new URLSearchParams(queryString);
        
        // Extract filters
        const filtersParam = parsedParams.get('filters');
        if (filtersParam) {
          queryParams.filters = JSON.parse(filtersParam);
        }
        
        // Extract pagination
        const pageParam = parsedParams.get('page');
        const pageSizeParam = parsedParams.get('pageSize');
        if (pageParam || pageSizeParam) {
          queryParams.pagination = {};
          if (pageParam) queryParams.pagination.page = parseInt(pageParam, 10);
          if (pageSizeParam) queryParams.pagination.pageSize = parseInt(pageSizeParam, 10);
        }
        
        // Extract sort
        const sortParam = parsedParams.get('sort');
        if (sortParam) {
          queryParams.sort = sortParam.split(',');
        }
        
        // Extract populate
        const populateParam = parsedParams.get('populate');
        if (populateParam) {
          try {
            // Try to parse as JSON
            queryParams.populate = JSON.parse(populateParam);
          } catch {
            // If not valid JSON, treat as comma-separated string
            queryParams.populate = populateParam.split(',');
          }
        }
        
        // Extract fields
        const fieldsParam = parsedParams.get('fields');
        if (fieldsParam) {
          queryParams.fields = fieldsParam.split(',');
        }
      } catch (parseError) {
        console.error("[Error] Failed to parse query parameters:", parseError);
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Invalid query parameters: ${parseError instanceof Error ? parseError.message : String(parseError)}`
        );
      }
    }
    
    // If an entry ID is provided, fetch that specific entry
    if (entryId) {
      const entry = await fetchEntry(contentTypeUid, entryId, queryParams);
      
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(entry, null, 2)
        }]
      };
    }
    
    // Otherwise, fetch entries with query parameters
    const entries = await fetchEntries(contentTypeUid, queryParams);
    
    // Return the entries as JSON
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(entries, null, 2)
      }]
    };
  } catch (error) {
    console.error("[Error] Failed to read resource:", error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read resource: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

/**
 * Handler that lists available tools.
 * Exposes tools for working with Strapi content.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_content_types",
        description: "List all available content types in Strapi",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "get_entries",
        description: "Get entries for a specific content type with optional filtering, pagination, sorting, and population of relations",
        inputSchema: {
          type: "object",
          properties: {
            contentType: {
              type: "string",
              description: "The content type UID (e.g., 'api::article.article')"
            },
            options: {
              type: "string",
              description: "JSON string with query options including filters, pagination, sort, populate, and fields. Example: '{\"filters\":{\"title\":{\"$contains\":\"hello\"}},\"pagination\":{\"page\":1,\"pageSize\":10},\"sort\":[\"title:asc\"],\"populate\":[\"author\",\"categories\"],\"fields\":[\"title\",\"content\"]}'"
            }
          },
          required: ["contentType"]
        }
      },
      {
        name: "get_entry",
        description: "Get a specific entry by ID",
        inputSchema: {
          type: "object",
          properties: {
            contentType: {
              type: "string",
              description: "The content type UID (e.g., 'api::article.article')"
            },
            id: {
              type: "string",
              description: "The ID of the entry"
            },
            options: {
              type: "string",
              description: "JSON string with query options including populate and fields. Example: '{\"populate\":[\"author\",\"categories\"],\"fields\":[\"title\",\"content\"]}'"
            }
          },
          required: ["contentType", "id"]
        }
      },
      {
        name: "create_entry",
        description: "Create a new entry for a content type",
        inputSchema: {
          type: "object",
          properties: {
            contentType: {
              type: "string",
              description: "The content type UID (e.g., 'api::article.article')"
            },
            data: {
              type: "object",
              description: "The data for the new entry"
            }
          },
          required: ["contentType", "data"]
        }
      },
      {
        name: "update_entry",
        description: "Update an existing entry",
        inputSchema: {
          type: "object",
          properties: {
            contentType: {
              type: "string",
              description: "The content type UID (e.g., 'api::article.article')"
            },
            id: {
              type: "string",
              description: "The ID of the entry to update"
            },
            data: {
              type: "object",
              description: "The updated data for the entry"
            }
          },
          required: ["contentType", "id", "data"]
        }
      },
      {
        name: "delete_entry",
        description: "Deletes a specific entry.",
        inputSchema: {
          type: "object",
          properties: {
            contentType: {
              type: "string",
              description: "Content type UID.",
            },
            id: {
              type: "string",
              description: "Entry ID.",
            },
          },
          required: ["contentType", "id"]
        }
      },
      {
        name: "upload_media",
        description: "Upload a media file to the Strapi Media Library. Maximum size: ~750KB file (1MB base64). For larger files, use upload_media_from_path.",
        inputSchema: {
          type: "object",
          properties: {
            fileData: {
              type: "string",
              description: "Base64 encoded string of the file data. Large files cause context window overflow.",
            },
            fileName: {
              type: "string",
              description: "The desired name for the file.",
            },
            fileType: {
              type: "string",
              description: "The MIME type of the file (e.g., 'image/jpeg', 'application/pdf').",
            },
          },
          required: ["fileData", "fileName", "fileType"]
        }
      },
      {
        name: "upload_media_from_path",
        description: "Upload a media file from a local file path with optional folder support. Avoids context window overflow issues. Maximum size: 10MB.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Local file system path to the file to upload.",
            },
            fileName: {
              type: "string",
              description: "Optional: Override the file name. If not provided, uses the original filename.",
            },
            fileType: {
              type: "string",
              description: "Optional: Override the MIME type. If not provided, auto-detects from file extension.",
            },
            folderName: {
              type: "string",
              description: "Optional: Folder name to upload the file to. If folder doesn't exist, it will be created. If not provided, uploads to root folder.",
            },
          },
          required: ["filePath"]
        }
      },
      {
        name: "get_content_type_schema",
        description: "Get the schema (fields, types, relations) for a specific content type.",
        inputSchema: {
          type: "object",
          properties: {
            contentType: {
              type: "string",
              description: "The API ID of the content type (e.g., 'api::article.article').",
            },
          },
          required: ["contentType"]
        }
      },
      {
        name: "connect_relation",
        description: "Connects related entries to a relation field.",
        inputSchema: {
          type: "object",
          properties: {
            contentType: { type: "string", description: "Main content type UID." },
            id: { type: "string", description: "Main entry ID." },
            relationField: { type: "string", description: "Relation field name." },
            relatedIds: { type: "array", items: { type: "string" }, description: "Array of entry IDs to connect." }
          },
          required: ["contentType", "id", "relationField", "relatedIds"]
        }
      },
      {
        name: "disconnect_relation",
        description: "Disconnects related entries from a relation field.",
        inputSchema: {
          type: "object",
          properties: {
            contentType: { type: "string", description: "Main content type UID." },
            id: { type: "string", description: "Main entry ID." },
            relationField: { type: "string", description: "Relation field name." },
            relatedIds: { type: "array", items: { type: "string" }, description: "Array of entry IDs to disconnect." }
          },
          required: ["contentType", "id", "relationField", "relatedIds"]
         }
       },
       {
         name: "create_content_type",
         description: "Creates a new content type (Admin privileges required).",
         inputSchema: {
           type: "object",
           properties: {
             displayName: { type: "string", description: "Display name for content type." },
             singularName: { type: "string", description: "Singular name for API ID." },
             pluralName: { type: "string", description: "Plural name for API ID." },
             kind: { type: "string", enum: ["collectionType", "singleType"], default: "collectionType", description: "Kind of content type." },
             description: { type: "string", description: "Optional description." },
             draftAndPublish: { type: "boolean", default: true, description: "Enable draft/publish?" },
             attributes: {
               type: "object",
               description: "Fields for the content type. E.g., { \"title\": { \"type\": \"string\" } }",
               additionalProperties: {
                 type: "object",
                 properties: {
                   type: { type: "string", description: "Field type (string, text, number, etc.)" },
                   required: { type: "boolean", description: "Is this field required?" },
                   // Add other common attribute properties as needed
                 },
                 required: ["type"]
               }
             }
           },
           required: ["displayName", "singularName", "pluralName", "attributes"]
         }
       },
       {
         name: "update_content_type",
         description: "Updates a content type attributes (Admin privileges required).",
         inputSchema: {
           type: "object",
           properties: {
             contentType: { type: "string", description: "UID of content type to update." },
             attributes: {
               type: "object",
               description: "Attributes to add/update. E.g., { \"new_field\": { \"type\": \"boolean\" } }",
               additionalProperties: {
                 type: "object",
                 properties: {
                   type: { type: "string", description: "Field type (string, boolean, etc.)" },
                   // Include other relevant attribute properties like 'required', 'default', 'relation', 'target', etc.
                 },
                 required: ["type"]
               }
             }
           },
           required: ["contentType", "attributes"]
         }
       },
       {
         name: "delete_content_type",
         description: "Deletes a content type (Admin privileges required).",
         inputSchema: {
           type: "object",
           properties: {
             contentType: { type: "string", description: "UID of content type to delete (e.g., 'api::test.test')." }
           },
           required: ["contentType"]
         }
       },
       {
         name: "list_components",
         description: "List all available components in Strapi",
         inputSchema: {
           type: "object",
           properties: {}
         }
       },
       {
         name: "get_component_schema",
         description: "Get the schema for a specific component",
         inputSchema: {
           type: "object",
           properties: {
             componentUid: {
               type: "string",
               description: "The API ID of the component"
             }
           },
           required: ["componentUid"]
         }
       },
       {
         name: "create_component",
         description: "Create a new component",
         inputSchema: {
           type: "object",
           properties: {
             displayName: {
               type: "string",
               description: "The display name of the component"
             },
             category: {
               type: "string",
               description: "The category of the component"
             },
             attributes: {
               type: "object",
               description: "The attributes (fields) of the component"
             },
             icon: {
               type: "string",
               description: "Optional icon for the component"
             }
           },
           required: ["displayName", "category", "attributes"]
         }
       },
       {
         name: "update_component",
         description: "Update an existing component",
         inputSchema: {
           type: "object",
           properties: {
             componentUid: {
               type: "string",
               description: "The API ID of the component to update"
             },
             attributesToUpdate: {
               type: "object",
               description: "The attributes to update for the component"
             }
           },
           required: ["componentUid", "attributesToUpdate"]
         }
       },
       {
         name: "publish_entry",
         description: "Publishes a specific entry.",
         inputSchema: {
           type: "object",
           properties: {
             contentType: {
               type: "string",
               description: "Content type UID."
             },
             id: {
               type: "string",
               description: "Entry ID."
             }
           },
           required: ["contentType", "id"]
         }
       },
       {
         name: "unpublish_entry",
         description: "Unpublishes a specific entry.",
         inputSchema: {
           type: "object",
           properties: {
             contentType: {
               type: "string",
               description: "Content type UID."
             },
             id: {
               type: "string",
               description: "Entry ID."
             }
           },
           required: ["contentType", "id"]
         }
       },
     ]
   };
 });

/**
 * Handler for tool calls.
 * Implements various tools for working with Strapi content.
 */
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  try {
    switch (request.params.name) {
      case "list_content_types": {
        const response = await listContentTypesUnified();
        
        if (response.error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to list content types: ${response.error.message}`
          );
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              contentTypes: response.data.map((ct: any) => ({
                uid: ct.uid,
                displayName: ct.info.displayName,
                description: ct.info.description
              })),
              meta: {
                format: response.format,
                total: response.data.length
              }
            }, null, 2)
          }]
        };
      }
      
      case "get_entries": {
        const { contentType, options } = request.params.arguments as any;
        if (!contentType) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type is required"
          );
        }
        
        // Parse the options string into a queryParams object
        let queryParams: QueryParams = {};
        if (options) {
          try {
            queryParams = JSON.parse(options);
          } catch (parseError) {
            console.error("[Error] Failed to parse query options:", parseError);
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid query options: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            );
          }
        }
        
        // Use enhanced function with unified response
        const response = await fetchEntriesUnified(String(contentType), queryParams);
        
        if (response.error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to get entries: ${response.error.message}`
          );
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              data: response.data,
              meta: {
                ...response.meta,
                format: response.format
              }
            }, null, 2)
          }]
        };
      }
      
      case "get_entry": {
        const { contentType, id, options } = request.params.arguments as any;
        
        if (!contentType || !id) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type and ID are required"
          );
        }
        
        // Parse the options string into a queryParams object
        let queryParams: QueryParams = {};
        if (options) {
          try {
            queryParams = JSON.parse(options);
          } catch (parseError) {
            console.error("[Error] Failed to parse query options:", parseError);
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid query options: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            );
          }
        }
        
        // Use enhanced function with unified response
        const response = await fetchEntryUnified(String(contentType), String(id), queryParams);
        
        if (response.error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to get entry: ${response.error.message}`
          );
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              data: response.data,
              meta: {
                ...response.meta,
                format: response.format
              }
            }, null, 2)
          }]
        };
      }
      
      case "create_entry": {
        const contentType = String(request.params.arguments?.contentType);
        const data = request.params.arguments?.data;
        
        if (!contentType || !data) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type and data are required"
          );
        }
        
        // Use enhanced function with unified response
        const response = await createEntryUnified(contentType, data);
        
        if (response.error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to create entry: ${response.error.message}`
          );
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              data: response.data,
              meta: {
                ...response.meta,
                format: response.format
              }
            }, null, 2)
          }]
        };
      }
      
      case "update_entry": {
        const contentType = String(request.params.arguments?.contentType);
        const id = String(request.params.arguments?.id);
        const data = request.params.arguments?.data;
        
        if (!contentType || !id || !data) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type, ID, and data are required"
          );
        }
        
        // Use enhanced function with unified response
        const response = await updateEntryUnified(contentType, id, data);
        
        if (response.error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to update entry: ${response.error.message}`
          );
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              data: response.data,
              meta: {
                ...response.meta,
                format: response.format
              }
            }, null, 2)
          }]
        };
      }
      
      case "delete_entry": {
        const contentType = String(request.params.arguments?.contentType);
        const id = String(request.params.arguments?.id);
        
        if (!contentType || !id) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type and ID are required"
          );
        }
        
        // Use enhanced function with unified response
        const response = await deleteEntryUnified(contentType, id);
        
        if (response.error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to delete entry: ${response.error.message}`
          );
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              data: response.data,
              meta: {
                ...response.meta,
                format: response.format
              }
            }, null, 2)
          }]
        };
      }
      
      case "upload_media": {
        const fileData = String(request.params.arguments?.fileData);
        const fileName = String(request.params.arguments?.fileName);
        const fileType = String(request.params.arguments?.fileType);
        
        if (!fileData || !fileName || !fileType) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "File data, file name, and file type are required"
          );
        }
        
        // Log a truncated version of the fileData to avoid context overflow in logs
        const truncatedFileData = fileData.length > 100 ? `${fileData.substring(0, 100)}... [${fileData.length} chars total]` : fileData;
        console.error(`[API] Received base64 upload request: fileName=${fileName}, fileType=${fileType}, data=${truncatedFileData}`);
        
        const media = await uploadMedia(fileData, fileName, fileType);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(media, null, 2)
          }]
        };
      }
      
      case "upload_media_from_path": {
        const filePath = String(request.params.arguments?.filePath);
        const fileName = request.params.arguments?.fileName ? String(request.params.arguments.fileName) : undefined;
        const fileType = request.params.arguments?.fileType ? String(request.params.arguments.fileType) : undefined;
        const folderName = request.params.arguments?.folderName ? String(request.params.arguments.folderName) : undefined;
        
        if (!filePath) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "File path is required"
          );
        }
        
        const media = await uploadMediaFromPath(filePath, fileName, fileType, folderName);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(media, null, 2)
          }]
        };
      }
      
      case "get_content_type_schema": {
        const contentType = String(request.params.arguments?.contentType);
        if (!contentType) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type is required"
          );
        }
        const schema = await fetchContentTypeSchema(contentType);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(schema, null, 2)
          }]
        };
      }
      
      case "connect_relation": {
        const { contentType, id, relationField, relatedIds } = request.params.arguments as any;
        if (!contentType || !id || !relationField || !Array.isArray(relatedIds)) {
          throw new McpError(ErrorCode.InvalidParams, "contentType, id, relationField, and relatedIds (array) are required.");
        }
        const result = await connectRelation(String(contentType), String(id), String(relationField), relatedIds);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "disconnect_relation": {
         const { contentType, id, relationField, relatedIds } = request.params.arguments as any;
         if (!contentType || !id || !relationField || !Array.isArray(relatedIds)) {
          throw new McpError(ErrorCode.InvalidParams, "contentType, id, relationField, and relatedIds (array) are required.");
        }
         const result = await disconnectRelation(String(contentType), String(id), String(relationField), relatedIds);
         return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
       }
 
       case "create_content_type": {
         const contentTypeData = request.params.arguments;
         if (!contentTypeData || typeof contentTypeData !== 'object') {
           throw new McpError(ErrorCode.InvalidParams, "Content type data object is required.");
         }
         // We pass the whole arguments object to the function
         const creationResult = await createContentType(contentTypeData);
         return {
           content: [{
             type: "text",
             text: JSON.stringify(creationResult, null, 2)
          }]
        };
      }

      case "update_content_type": {
        const { contentType, attributes } = request.params.arguments as any;
        if (!contentType || !attributes || typeof attributes !== 'object') {
           throw new McpError(ErrorCode.InvalidParams, "contentType (string) and attributes (object) are required.");
         }
         const updateResult = await updateContentType(String(contentType), attributes);
         return {
           content: [{
            type: "text",
            text: JSON.stringify(updateResult, null, 2)
          }]
        };
      }

      case "delete_content_type": {
        const contentTypeUid = String(request.params.arguments?.contentType);
        if (!contentTypeUid) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type UID is required"
          );
        }
        const deletionResult = await deleteContentType(contentTypeUid);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(deletionResult, null, 2)
          }]
        };
      }

      case "list_components": {
        const components = await listComponents();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(components, null, 2)
          }]
        };
      }

      case "get_component_schema": {
        const componentUid = String(request.params.arguments?.componentUid);
        if (!componentUid) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Component UID is required"
          );
        }
        const schema = await getComponentSchema(componentUid);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(schema, null, 2)
          }]
        };
      }

      case "create_component": {
        // Direct component fields instead of wrapped componentData
        const { displayName, category, attributes, icon } = request.params.arguments as any;
        
        if (!displayName || !category || !attributes) {
          throw new McpError(
            ErrorCode.InvalidParams, 
            "Missing required fields: displayName, category, attributes"
          );
        }
        
        // Create componentData object for internal function
        const componentData = { displayName, category, attributes, icon };
        
        console.error(`[MCP] Creating component: ${displayName} in category: ${category}`);
        const creationResult = await createComponent(componentData);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(creationResult, null, 2)
          }]
        };
      }

      case "update_component": {
        const { componentUid, attributesToUpdate } = request.params.arguments as any;
        if (!componentUid || !attributesToUpdate || typeof attributesToUpdate !== 'object') {
          throw new McpError(ErrorCode.InvalidParams, "componentUid (string) and attributesToUpdate (object) are required.");
        }
        const updateResult = await updateComponent(String(componentUid), attributesToUpdate);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(updateResult, null, 2)
          }]
        };
      }

      case "publish_entry": {
        const contentType = String(request.params.arguments?.contentType);
        const id = String(request.params.arguments?.id);
        
        if (!contentType || !id) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type and ID are required"
          );
        }
        
        const result = await publishEntry(contentType, id);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      }
      
      case "unpublish_entry": {
        const contentType = String(request.params.arguments?.contentType);
        const id = String(request.params.arguments?.id);
        
        if (!contentType || !id) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Content type and ID are required"
          );
        }
        
        const result = await unpublishEntry(contentType, id);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
    }
  } catch (error) {
    console.error(`[Error] Tool execution failed: ${error instanceof Error ? error.message : String(error)}`);
    
    if (error instanceof McpError) {
      throw error;
    }
    
    return {
      content: [{
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

/**
 * Start the server using stdio transport.
 */
async function main() {
  console.error("[Setup] Starting Strapi MCP server");
  
  // Version detection
  detectedStrapiVersion = await detectStrapiVersion();
  console.error(`[Setup] Target Strapi version: ${detectedStrapiVersion}`);
  console.error(`[Setup] Migration mode: ${detectedStrapiVersion === 'v5' ? 'v5 native' : 'v4 compatible'}`);
  
  // Debug environment variables
  console.error("[Setup] 🔍 Debug - Environment Variables:");
  console.error(`[Setup] STRAPI_URL: ${STRAPI_URL}`);
  console.error(`[Setup] STRAPI_ADMIN_EMAIL: ${STRAPI_ADMIN_EMAIL ? 'SET' : 'NOT SET'}`);
  console.error(`[Setup] STRAPI_ADMIN_PASSWORD: ${STRAPI_ADMIN_PASSWORD ? 'SET' : 'NOT SET'}`);
  console.error(`[Setup] STRAPI_API_TOKEN: ${STRAPI_API_TOKEN ? 'SET' : 'NOT SET'}`);
  console.error(`[Setup] STRAPI_VERSION: ${STRAPI_VERSION}`);

  // Test Strapi connection and authentication BEFORE starting server
  try {
    await validateStrapiConnection();
    console.error("[Setup] ✅ Strapi connection and authentication validated");
  } catch (connectionError) {
    console.error("[Setup] ❌ Failed to validate Strapi connection:", connectionError);
    console.error("[Setup] Server will start but some operations may fail until Strapi is available");
  }
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Setup] Strapi MCP server running");
}

main().catch((error) => {
  console.error("[Error] Server error:", error);
  process.exit(1);
});

/**
 * Delete a content type from Strapi. Requires admin privileges.
 */
async function deleteContentType(contentTypeUid: string): Promise<any> {
  try {
    console.error(`[API] Deleting content type: ${contentTypeUid}`);
    
    // Validate that this is a proper content type UID
    if (!contentTypeUid || !contentTypeUid.includes('.')) {
      throw new Error(`Invalid content type UID: ${contentTypeUid}. UID should be in the format 'api::name.name'`);
    }
    
    // Make the DELETE request using admin credentials
    const endpoint = `/content-type-builder/content-types/${contentTypeUid}`;
    console.error(`[API] Sending DELETE request to: ${endpoint}`);
    
    const response = await makeAdminApiRequest(endpoint, 'delete');
    console.error(`[API] Content type deletion response:`, response);
    
    // Return the response data or a success message
    return response?.data || { message: `Content type ${contentTypeUid} deleted. Strapi might be restarting.` };
  } catch (error: any) {
    console.error(`[Error] Failed to delete content type ${contentTypeUid}:`, error);
    
    let errorMessage = `Failed to delete content type ${contentTypeUid}`;
    let errorCode = ExtendedErrorCode.InternalError;
    
    if (axios.isAxiosError(error)) {
      errorMessage += `: ${error.response?.status} ${error.response?.statusText}`;
      if (error.response?.status === 404) {
        errorCode = ExtendedErrorCode.ResourceNotFound;
        errorMessage += ` (Content type not found)`;
      } else if (error.response?.status === 400) {
        errorCode = ExtendedErrorCode.InvalidParams;
        errorMessage += ` (Bad Request): ${JSON.stringify(error.response?.data)}`;
      } else if (error.response?.status === 403 || error.response?.status === 401) {
        errorCode = ExtendedErrorCode.AccessDenied;
        errorMessage += ` (Permission Denied - Admin credentials might lack permissions)`;
      }
    } else if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
    } else {
      errorMessage += `: ${String(error)}`;
    }
    
    throw new ExtendedMcpError(errorCode, errorMessage);
  }
}

// Add connection validation flag
let connectionValidated = false;

/**
 * Test connection to Strapi and validate authentication
 */
async function validateStrapiConnection(): Promise<void> {
  if (connectionValidated) return; // Already validated
  
  try {
    console.error("[Setup] Validating connection to Strapi...");
    
    // First try admin authentication if available
    if (STRAPI_ADMIN_EMAIL && STRAPI_ADMIN_PASSWORD) {
      try {
        // Test admin login
        await loginToStrapiAdmin();
        const response = await makeAdminApiRequest('/admin/users/me');
        console.error("[Setup] ✓ Admin authentication successful");
        
        // Admin authentication başarılı olduğunda direkt çık
        console.error("[Setup] ✓ Connection to Strapi successful using admin credentials");
        connectionValidated = true;
        return; // Exit early on success
      } catch (adminError) {
        console.error("[Setup] Admin authentication failed, trying API token...");
        // Fall through to API token test
      }
    }
    
    // If admin failed or not available, try API token
    if (!connectionValidated && STRAPI_API_TOKEN) {
      try {
        // Try a simple endpoint that should exist - use upload/files to test API token
        const response = await strapiClient.get('/api/upload/files?pagination[limit]=1');
        console.error("[Setup] ✓ API token authentication successful");
        console.error("[Setup] ✓ Connection to Strapi successful using API token");
        connectionValidated = true;
        return;
      } catch (apiError) {
        console.error("[Setup] API token test failed, trying root endpoint...");
        // Last resort - try to hit the root to see if server is running
        try {
          const response = await strapiClient.get('/');
          console.error("[Setup] ✓ Server is reachable");
          console.error("[Setup] ✓ Connection to Strapi successful using server connection");
          connectionValidated = true;
          return;
        } catch (rootError) {
          console.error("[Setup] Root endpoint test also failed");
        }
      }
    }
    
    // If we reach here, all tests failed
    if (!connectionValidated) {
      throw new Error("All connection tests failed");
    }
  } catch (error: any) {
    console.error("[Setup] ✗ Failed to connect to Strapi");
    
    let errorMessage = "Cannot connect to Strapi instance";
    
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED') {
        errorMessage += `: Connection refused. Is Strapi running at ${STRAPI_URL}?`;
      } else if (error.response?.status === 401) {
        errorMessage += `: Authentication failed. Check your API token or admin credentials.`;
      } else if (error.response?.status === 403) {
        errorMessage += `: Access forbidden. Your API token may lack necessary permissions.`;
      } else if (error.response?.status === 404) {
        errorMessage += `: Endpoint not found. Strapi server might be running but not properly configured.`;
      } else {
        errorMessage += `: ${error.message}`;
      }
    } else {
      errorMessage += `: ${error.message}`;
    }
    
    throw new ExtendedMcpError(ExtendedErrorCode.InternalError, errorMessage);
  }
}
