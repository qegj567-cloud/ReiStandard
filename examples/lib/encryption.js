// Noir's Ultimate & Compatible Encryption Protocol v2.0 (using crypto-js)
// 哼，这次用了更可靠的工具，看你还怎么出错！
const CryptoJS = require('crypto-js');
const crypto = require('crypto'); // Node.js built-in crypto for PBKDF2

const MASTER_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!MASTER_ENCRYPTION_KEY) {
  console.error('FATAL: MASTER_ENCRYPTION_KEY environment variable is not set!');
  // 在 serverless 环境下可能需要不同的处理方式，但至少要报错
}

// 密钥派生 (还是用 Node.js 的 PBKDF2，这个比较标准)
function deriveUserEncryptionKey(userId) {
  const salt = "rei-standard-salt"; // 固定盐
  const iterations = 100000;
  const keyLength = 32; // 256 bits for AES key
  const digest = 'sha256';

  // 哼，注意这里！我们只派生出密钥本身 (Buffer)
  return crypto.pbkdf2Sync(userId, salt, iterations, keyLength, digest);
}

// 加密负载 (使用 crypto-js 的 AES)
function encryptPayload(payload, keyBuffer) {
  try {
    const keyHex = keyBuffer.toString('hex');
    const key = CryptoJS.enc.Hex.parse(keyHex);
    // IV需要16字节(128位)，CryptoJS 会自动处理
    const iv = CryptoJS.lib.WordArray.random(16);

    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), key, {
      iv: iv,
      mode: CryptoJS.mode.CBC, // 改用 CBC 模式，GCM 在 crypto-js 中不太好用
      padding: CryptoJS.pad.Pkcs7
    });

    // 哼，把 IV 和密文拼在一起，用 Base64 编码，简单粗暴
    const ivBase64 = CryptoJS.enc.Base64.stringify(iv);
    const encryptedBase64 = encrypted.toString(); // CryptoJS 默认输出 Base64

    // 返回稍微不同的格式，但包含了所有信息
    return {
      iv: ivBase64,
      encryptedData: encryptedBase64 // 只包含密文部分
      // 不需要 authTag 了，因为 CBC 模式没有这个
    };
  } catch (error) {
    console.error("CryptoJS Encryption Error:", error);
    throw new Error('加密失败: ' + error.message);
  }
}

// 解密负载 (使用 crypto-js 的 AES)
function decryptPayload(encryptedPayload, keyBuffer) {
  try {
    const keyHex = keyBuffer.toString('hex');
    const key = CryptoJS.enc.Hex.parse(keyHex);
    const iv = CryptoJS.enc.Base64.parse(encryptedPayload.iv);

    const decrypted = CryptoJS.AES.decrypt(encryptedPayload.encryptedData, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    });

    const decryptedUtf8 = decrypted.toString(CryptoJS.enc.Utf8);
    if (!decryptedUtf8) {
         throw new Error('Decryption resulted in empty string. Check key or IV.');
    }
    return JSON.parse(decryptedUtf8);
  } catch (error) {
    console.error("CryptoJS Decryption Error:", error);
    // 提供更详细的错误信息
    if (error instanceof SyntaxError) {
      throw new Error('解密后的数据不是有效的JSON。');
    }
    // 对于 CryptoJS 可能的错误 (例如填充错误)，给出通用提示
    throw new Error('请求体解密失败，可能是密钥不匹配或数据已损坏。');
  }
}


// 存储加密 (保持不变，因为是服务器内部使用)
function encryptForStorage(text, keyBuffer) {
   const iv = crypto.randomBytes(12);
   const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
   let encrypted = cipher.update(text, 'utf8', 'hex');
   encrypted += cipher.final('hex');
   const authTag = cipher.getAuthTag();
   return JSON.stringify({
     iv: iv.toString('hex'),
     encryptedData: encrypted,
     authTag: authTag.toString('hex')
   });
 }

 function decryptFromStorage(encryptedJsonString, keyBuffer) {
   try {
     const encryptedData = JSON.parse(encryptedJsonString);
     const iv = Buffer.from(encryptedData.iv, 'hex');
     const authTag = Buffer.from(encryptedData.authTag, 'hex');
     const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
     decipher.setAuthTag(authTag);
     let decrypted = decipher.update(encryptedData.encryptedData, 'hex', 'utf8');
     decrypted += decipher.final('utf8');
     return decrypted;
   } catch (error) {
     console.error("Error decrypting from storage:", error);
     return null; // Or handle error appropriately
   }
 }

module.exports = {
  deriveUserEncryptionKey,
  encryptPayload,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
};
