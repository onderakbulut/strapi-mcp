#!/usr/bin/env node

/**
 * Context Window Example Script
 * 
 * This script demonstrates the context window overflow issue with base64 uploads
 * and shows how to use the new upload_media_from_path tool as a solution.
 */

console.log('=== Strapi MCP Context Window Overflow Solutions ===\n');

console.log('PROBLEM:');
console.log('- Base64 encoded files can be extremely large (50-100KB+ of text)');
console.log('- Large base64 strings cause context window overflow in MCP tools');
console.log('- Even small images (200KB file) become 270KB+ of base64 text');
console.log('- This fills up the context window quickly, causing errors\n');

console.log('SOLUTIONS:\n');

console.log('1. USE upload_media_from_path (RECOMMENDED):');
console.log('   - Supports files up to 10MB');
console.log('   - Avoids context window issues');
console.log('   - Auto-detects file type from extension');
console.log('   - Example usage:');
console.log(`   {
     "tool_name": "upload_media_from_path",
     "arguments": {
       "filePath": "/path/to/your/image.jpg"
     }
   }\n`);

console.log('2. USE upload_media for small files only:');
console.log('   - Maximum: 1MB base64 text (~750KB file)');
console.log('   - Server now enforces size limits');
console.log('   - Base64 data filtered from responses');
console.log('   - Example usage:');
console.log(`   {
     "tool_name": "upload_media",
     "arguments": {
       "fileData": "iVBORw0KGgoAAAANSUhEUgA...", // Keep this small!
       "fileName": "small-image.jpg",
       "fileType": "image/jpeg"
     }
   }\n`);

console.log('3. SIZE LIMITS & WARNINGS:');
console.log('   - Files > 100KB base64: Warning logged');
console.log('   - Files > 1MB base64: Upload rejected');
console.log('   - Large responses: Base64 data automatically filtered');
console.log('   - Logs: Base64 data truncated to prevent spam\n');

console.log('4. FILE SIZE CALCULATOR:');
const fileSizes = [
  { fileKB: 100, base64KB: Math.round((100 * 4) / 3) },
  { fileKB: 500, base64KB: Math.round((500 * 4) / 3) },
  { fileKB: 750, base64KB: Math.round((750 * 4) / 3) }, // Max for upload_media
  { fileKB: 1000, base64KB: Math.round((1000 * 4) / 3) },
  { fileKB: 5000, base64KB: Math.round((5000 * 4) / 3) }
];

fileSizes.forEach(size => {
  const method = size.fileKB <= 750 ? 'upload_media OR upload_media_from_path' : 'upload_media_from_path ONLY';
  console.log(`   ${size.fileKB}KB file → ${size.base64KB}KB base64 → ${method}`);
});

console.log('\n=== RECOMMENDATIONS ===');
console.log('✅ Use upload_media_from_path for all files when possible');
console.log('✅ Only use upload_media for very small files (<500KB)'); 
console.log('✅ Compress images before uploading to reduce size');
console.log('✅ Monitor file sizes to avoid context window issues');
console.log('❌ Avoid uploading large files via base64 (causes overflow)');

console.log('\nFor more information, see the troubleshooting section in README.md'); 