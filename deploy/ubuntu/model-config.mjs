/** Explicit deployment route. Credential values never belong in this module or the profile. */
export const CPA_PROVIDER='cpa';
export const CPA_MODEL='gpt-6.1-sol';
export const CPA_BASE_URL='http://10.242.66.179:8317/v1';
export const CPA_CREDENTIAL_REF='CPA_API_KEY';
export const cpaProviderConfig={providers:{[CPA_PROVIDER]:{
 displayName:'CPA',apiKeyEnv:CPA_CREDENTIAL_REF,api:'openai-responses',baseURL:CPA_BASE_URL,
 retryPolicy:{mode:'normal',maxRetries:0},
 maxRequestImageBytes:20*1024*1024,requestImagePixelBudget:2048*2048,requestImageMaxBytes:1024*1024,
 models:[{id:CPA_MODEL,name:CPA_MODEL,input:['text','image']}],
}}};
