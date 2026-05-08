# Medical Information Security Guidelines for Familiar

## Document Purpose
This document outlines comprehensive security requirements and implementation guidelines that Familiar must fulfill to ensure proper handling, storage, and transmission of medical information in compliance with international healthcare data protection standards.

---

## 1. Regulatory Compliance Overview

### 1.1 HIPAA (Health Insurance Portability and Accountability Act)
**Applicability**: US citizens and any organization processing healthcare data of American citizens globally.

**Key Components**:
- **Privacy Rule**: National standards for protecting health information
- **Security Rule**: Technical and non-technical safeguards for electronic Protected Health Information (ePHI)
- **Breach Notification Rule**: Requirements for breach disclosure

### 1.2 GDPR (General Data Protection Regulation)
**Applicability**: EU citizens and organizations processing EU health data.

**Key Requirements**:
- Health data classified as "special category" requiring enhanced protection
- Explicit consent required for processing
- Right to data portability and erasure
- Data Protection Impact Assessments (DPIA) mandatory

### 1.3 HITECH Act
**Purpose**: Stimulates adoption of electronic health records with enhanced security provisions.

---

## 2. Core Security Principles

### 2.1 Confidentiality
**Definition**: Data or information is not made available or disclosed to unauthorized persons or processes.

**Implementation Requirements**:
- Access controls limiting who can view medical information
- Encryption for data at rest and in transit
- Secure authentication mechanisms

### 2.2 Integrity
**Definition**: Data or information has not been altered or destroyed in an unauthorized manner.

**Implementation Requirements**:
- Audit trails for all data modifications
- Digital signatures for critical records
- Version control for medical documents
- Data validation and checksums

### 2.3 Availability
**Definition**: Data or information is accessible and useable upon demand by authorized persons.

**Implementation Requirements**:
- High availability infrastructure (99.9%+ uptime)
- Regular backups with tested recovery procedures
- Redundant systems and failover mechanisms
- Disaster recovery plan

---

## 3. Technical Safeguards (HIPAA § 164.312)

### 3.1 Access Controls
**Requirement**: Implement technical policies and procedures for electronic information systems that maintain ePHI to allow access only to authorized persons or programs.

**Programmatic Implementation**:
```javascript
// Node.js/Express example with JWT authentication
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// User authentication middleware
const authenticateUser = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Role-Based Access Control (RBAC)
const checkPermission = (requiredRole) => {
  return (req, res, next) => {
    if (!req.user.roles.includes(requiredRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

// Example protected route
app.get('/api/patient/:id/records', 
  authenticateUser, 
  checkPermission('HEALTHCARE_PROVIDER'),
  async (req, res) => {
    // Access medical records logic
  }
);
```

```python
# Python/Django example with row-level security
from django.db import models
from django.contrib.auth.models import User

class MedicalRecord(models.Model):
    patient = models.ForeignKey(User, on_delete=models.CASCADE, related_name='medical_records')
    provider = models.ForeignKey(User, on_delete=models.CASCADE, related_name='created_records')
    authorized_viewers = models.ManyToManyField(User, related_name='viewable_records')
    
    def can_access(self, user):
        return (
            user == self.patient or 
            user == self.provider or 
            user in self.authorized_viewers.all() or
            user.groups.filter(name='Admin').exists()
        )

**Key Features**:
- **Unique User Identification**: Each user must have a unique identifier
- **Emergency Access Procedures**: Break-glass access for emergencies
- **Automatic Logoff**: Sessions timeout after inactivity (15-30 minutes recommended)
- **Encryption and Decryption**: Strong encryption for stored credentials

### 3.2 Audit Controls
**Requirement**: Implement mechanisms that record and examine activity in information systems containing ePHI.

**Programmatic Implementation**:

```javascript
// Audit logging middleware for Express
const auditLog = require('./models/AuditLog');

const auditMiddleware = async (req, res, next) => {
  const startTime = Date.now();
  
  // Capture response
  const originalSend = res.send;
  res.send = function(data) {
    res.send = originalSend;
    
    // Log the audit trail
    auditLog.create({
      userId: req.user?.id,
      action: `${req.method} ${req.path}`,
      resourceType: req.params.resourceType || 'unknown',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date(),
      duration: Date.now() - startTime,
      statusCode: res.statusCode,
      success: res.statusCode < 400
    });
    
    return res.send(data);
  };
  
  next();
};
```

```sql
-- Database schema for audit logs
CREATE TABLE audit_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    action VARCHAR(255) NOT NULL,
    resource_type VARCHAR(100),
    resource_id VARCHAR(100),
    ip_address VARCHAR(45),
    user_agent TEXT,
    timestamp DATETIME NOT NULL,
    duration_ms INT,
    status_code INT,
    success BOOLEAN,
    details JSON,
    INDEX idx_user_timestamp (user_id, timestamp),
    INDEX idx_resource (resource_type, resource_id),
    INDEX idx_timestamp (timestamp)
);
```

**Required Audit Information**:
- User ID performing the action
- Date and time of access
- Type of event (read, write, update, delete)
- Success or failure of the event
- Source of the event (workstation, application)

**Retention**: Audit logs must be retained for at least 6 years (HIPAA requirement).

### 3.3 Integrity Controls
**Requirement**: Implement policies and procedures to protect ePHI from improper alteration or destruction.

**Programmatic Implementation**:

```python
# Data integrity verification using checksums
import hashlib
import hmac

class DataIntegrityService:
    def __init__(self, secret_key):
        self.secret_key = secret_key
    
    def calculate_signature(self, data):
        """Calculate HMAC-SHA256 signature for data integrity"""
        message = json.dumps(data, sort_keys=True).encode('utf-8')
        signature = hmac.new(
            self.secret_key.encode('utf-8'),
            message,
            hashlib.sha256
        ).hexdigest()
        return signature
    
    def verify_integrity(self, data, signature):
        """Verify data has not been tampered with"""
        expected_signature = self.calculate_signature(data)
        return hmac.compare_digest(expected_signature, signature)
    
    def store_with_integrity(self, medical_record):
        """Store record with integrity check"""
        record_data = {
            'patient_id': medical_record.patient_id,
            'content': medical_record.content,
            'timestamp': medical_record.timestamp.isoformat()
        }
        
        signature = self.calculate_signature(record_data)
        
        # Store both data and signature
        medical_record.integrity_signature = signature
        medical_record.save()
        
        return medical_record
```

```javascript
// Blockchain-based immutable audit trail (optional advanced approach)
const { createHash } = require('crypto');

class BlockchainAuditTrail {
  constructor() {
    this.chain = [];
    this.createGenesisBlock();
  }
  
  createGenesisBlock() {
    this.chain.push({
      index: 0,
      timestamp: Date.now(),
      data: 'Genesis Block',
      previousHash: '0',
      hash: this.calculateHash(0, Date.now(), 'Genesis Block', '0')
    });
  }
  
  calculateHash(index, timestamp, data, previousHash) {
    return createHash('sha256')
      .update(`${index}${timestamp}${JSON.stringify(data)}${previousHash}`)
      .digest('hex');
  }
  
  addBlock(data) {
    const previousBlock = this.chain[this.chain.length - 1];
    const newBlock = {
      index: this.chain.length,
      timestamp: Date.now(),
      data: data,
      previousHash: previousBlock.hash,
      hash: this.calculateHash(
        this.chain.length,
        Date.now(),
        data,
        previousBlock.hash
      )
    };
    
    this.chain.push(newBlock);
    return newBlock;
  }
  
  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];
      
      if (currentBlock.hash !== this.calculateHash(
        currentBlock.index,
        currentBlock.timestamp,
        currentBlock.data,
        currentBlock.previousHash
      )) {
        return false;
      }
      
      if (currentBlock.previousHash !== previousBlock.hash) {
        return false;
      }
    }
    return true;
  }
}
```

### 3.4 Person or Entity Authentication
**Requirement**: Implement procedures to verify that a person or entity seeking access to ePHI is the one claimed.

**Programmatic Implementation**:

```javascript
// Multi-Factor Authentication (MFA) implementation
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

class MFAService {
  // Generate MFA secret for user
  async setupMFA(userId, userEmail) {
    const secret = speakeasy.generateSecret({
      name: `Familiar (${userEmail})`,
      length: 32
    });
    
    // Store secret in database (encrypted)
    await User.update(userId, {
      mfa_secret: encrypt(secret.base32),
      mfa_enabled: false // User must verify first
    });
    
    // Generate QR code for user to scan
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
    
    return {
      secret: secret.base32,
      qrCode: qrCodeUrl
    };
  }
  
  // Verify MFA token
  verifyMFAToken(secret, token) {
    return speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: token,
      window: 2 // Allow 2 time steps before/after
    });
  }
  
  // Enable MFA after successful verification
  async enableMFA(userId, verificationToken) {
    const user = await User.findById(userId);
    const decryptedSecret = decrypt(user.mfa_secret);
    
    if (this.verifyMFAToken(decryptedSecret, verificationToken)) {
      await User.update(userId, { mfa_enabled: true });
      return { success: true };
    }
    
    return { success: false, error: 'Invalid verification code' };
  }
}
```

```python
# Biometric authentication example (facial recognition)
import face_recognition
import numpy as np

class BiometricAuth:
    def enroll_user(self, user_id, image_path):
        """Enroll user's facial features"""
        image = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(image)
        
        if len(encodings) == 0:
            raise ValueError("No face detected in image")
        
        # Store encoding in database (encrypted)
        encoding_blob = encodings[0].tobytes()
        BiometricData.create(
            user_id=user_id,
            encoding=encrypt(encoding_blob),
            type='facial_recognition'
        )
        
        return True
    
    def authenticate_user(self, user_id, live_image_path):
        """Authenticate user via facial recognition"""
        stored_data = BiometricData.get(user_id=user_id)
        stored_encoding = np.frombuffer(
            decrypt(stored_data.encoding),
            dtype=np.float64
        )
        
        live_image = face_recognition.load_image_file(live_image_path)
        live_encodings = face_recognition.face_encodings(live_image)
        
        if len(live_encodings) == 0:
            return False
        
        # Compare faces
        matches = face_recognition.compare_faces(
            [stored_encoding],
            live_encodings[0],
            tolerance=0.6
        )
        
        return matches[0]
```

**Authentication Requirements**:
- **Multi-Factor Authentication (MFA)**: Required for all users accessing ePHI
- **Password Requirements**:
  - Minimum 12 characters
  - Mix of uppercase, lowercase, numbers, and special characters
  - Password history (cannot reuse last 10 passwords)
  - Maximum password age: 90 days
- **Biometric options**: Fingerprint, facial recognition (as secondary factor)
- **Session management**: Secure tokens with expiration

### 3.5 Transmission Security
**Requirement**: Implement technical security measures to guard against unauthorized access to ePHI transmitted over electronic communications networks.

**Programmatic Implementation**:

```javascript
// TLS/SSL configuration for Express.js
const https = require('https');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  }
}));

// TLS configuration
const tlsOptions = {
  key: fs.readFileSync('path/to/private-key.pem'),
  cert: fs.readFileSync('path/to/certificate.pem'),
  ca: fs.readFileSync('path/to/ca-cert.pem'),
  
  // Enforce TLS 1.2 and above
  minVersion: 'TLSv1.2',
  
  // Strong cipher suites
  ciphers: [
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-SHA256',
    'ECDHE-RSA-AES256-SHA384'
  ].join(':'),
  
  honorCipherOrder: true
};

// Create HTTPS server
const server = https.createServer(tlsOptions, app);

server.listen(443, () => {
  console.log('Secure server running on port 443');
});

// Redirect HTTP to HTTPS
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(80);
```

```python
# End-to-end encryption for stored medical records
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.backends import default_backend
import os
import base64

class EncryptionService:
    def __init__(self):
        self.backend = default_backend()
    
    def encrypt_data_aes_256(self, data, key):
        """Encrypt data using AES-256-GCM"""
        # Generate random IV
        iv = os.urandom(12)
        
        # Create cipher
        cipher = Cipher(
            algorithms.AES(key),
            modes.GCM(iv),
            backend=self.backend
        )
        
        encryptor = cipher.encryptor()
        ciphertext = encryptor.update(data.encode()) + encryptor.finalize()
        
        # Return IV + ciphertext + tag
        return base64.b64encode(iv + ciphertext + encryptor.tag)
    
    def decrypt_data_aes_256(self, encrypted_data, key):
        """Decrypt AES-256-GCM encrypted data"""
        encrypted_bytes = base64.b64decode(encrypted_data)
        
        # Extract IV, ciphertext, and tag
        iv = encrypted_bytes[:12]
        tag = encrypted_bytes[-16:]
        ciphertext = encrypted_bytes[12:-16]
        
        # Create cipher
        cipher = Cipher(
            algorithms.AES(key),
            modes.GCM(iv, tag),
            backend=self.backend
        )
        
        decryptor = cipher.decryptor()
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
        
        return plaintext.decode()
    
    def generate_key_pair(self):
        """Generate RSA key pair for asymmetric encryption"""
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=4096,
            backend=self.backend
        )
        public_key = private_key.public_key()
        
        return private_key, public_key
    
    def encrypt_with_public_key(self, data, public_key):
        """Encrypt data with RSA public key"""
        ciphertext = public_key.encrypt(
            data.encode(),
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )
        return base64.b64encode(ciphertext)
    
    def decrypt_with_private_key(self, encrypted_data, private_key):
        """Decrypt data with RSA private key"""
        ciphertext = base64.b64decode(encrypted_data)
        plaintext = private_key.decrypt(
            ciphertext,
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None
            )
        )
        return plaintext.decode()
```

**Encryption Standards**:
- **Data at Rest**: AES-256 encryption
- **Data in Transit**: TLS 1.2 or higher
- **Key Management**: Use Hardware Security Modules (HSM) or cloud KMS
- **Certificate Management**: Valid SSL/TLS certificates from trusted CAs

---

## 4. Administrative Safeguards

### 4.1 Security Management Process

**Required Components**:

1. **Risk Analysis**: Conduct regular risk assessments (annually minimum)
2. **Risk Management**: Implement security measures to reduce risks
3. **Sanction Policy**: Define and enforce penalties for security violations
4. **Information System Activity Review**: Regular review of audit logs

**Implementation Example**:

```javascript
// Automated security scanning and alerting
const securityScanner = {
  async scanForVulnerabilities() {
    const issues = [];
    
    // Check for weak passwords
    const weakPasswords = await User.find({
      password_strength: { $lt: 3 }
    });
    
    if (weakPasswords.length > 0) {
      issues.push({
        severity: 'HIGH',
        type: 'WEAK_PASSWORDS',
        count: weakPasswords.length,
        recommendation: 'Enforce password reset for affected users'
      });
    }
    
    // Check for inactive MFA users
    const noMFA = await User.find({
      mfa_enabled: false,
      role: { $in: ['HEALTHCARE_PROVIDER', 'ADMIN'] }
    });
    
    if (noMFA.length > 0) {
      issues.push({
        severity: 'CRITICAL',
        type: 'MFA_NOT_ENABLED',
        count: noMFA.length,
        recommendation: 'Require MFA for all privileged accounts'
      });
    }
    
    // Check for stale sessions
    const staleSessions = await Session.find({
      last_activity: { $lt: new Date(Date.now() - 30 * 60 * 1000) }
    });
    
    if (staleSessions.length > 0) {
      await Session.deleteMany({ _id: { $in: staleSessions.map(s => s._id) } });
      issues.push({
        severity: 'MEDIUM',
        type: 'STALE_SESSIONS_CLEARED',
        count: staleSessions.length
      });
    }
    
    // Alert security team if critical issues found
    if (issues.some(i => i.severity === 'CRITICAL')) {
      await this.alertSecurityTeam(issues);
    }
    
    return issues;
  },
  
  async alertSecurityTeam(issues) {
    // Send alerts via email, Slack, PagerDuty, etc.
    const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
    
    await EmailService.send({
      to: 'security-team@familiar.com',
      subject: `SECURITY ALERT: ${criticalIssues.length} Critical Issues Detected`,
      body: JSON.stringify(issues, null, 2)
    });
  }
};

// Schedule regular scans
setInterval(() => {
  securityScanner.scanForVulnerabilities();
}, 60 * 60 * 1000); // Every hour
```

### 4.2 Workforce Training

**Requirements**:
- Security awareness training for all employees (annually minimum)
- Role-specific training for those handling ePHI
- Training on incident response procedures
- Documentation of training completion

### 4.3 Contingency Plan

**Required Components**:

1. **Data Backup Plan**: Regular automated backups
2. **Disaster Recovery Plan**: Procedures to restore operations
3. **Emergency Mode Operation Plan**: Continue critical operations during crisis
4. **Testing and Revision**: Regular testing of contingency procedures

**Implementation Example**:

```python
# Automated backup system
import boto3
from datetime import datetime, timedelta
import schedule

class BackupService:
    def __init__(self):
        self.s3_client = boto3.client('s3')
        self.backup_bucket = 'familiar-hipaa-backups'
        
    def create_database_backup(self):
        """Create encrypted database backup"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_file = f'db_backup_{timestamp}.sql.gz.enc'
        
        # Dump database
        os.system(f'pg_dump -U postgres familiar_db | gzip > /tmp/{backup_file}')
        
        # Encrypt backup
        encryption_service = EncryptionService()
        with open(f'/tmp/{backup_file}', 'rb') as f:
            data = f.read()
        
        encrypted_data = encryption_service.encrypt_data_aes_256(
            data,
            os.environ['BACKUP_ENCRYPTION_KEY']
        )
        
        # Upload to S3 with encryption
        self.s3_client.put_object(
            Bucket=self.backup_bucket,
            Key=f'database/{backup_file}',
            Body=encrypted_data,
            ServerSideEncryption='AES256',
            StorageClass='STANDARD_IA'
        )
        
        # Log backup completion
        AuditLog.create(
            action='DATABASE_BACKUP_CREATED',
            details={'backup_file': backup_file},
            timestamp=datetime.now()
        )
        
        # Clean up old backups (keep 90 days)
        self.cleanup_old_backups(90)
        
        return backup_file
    
    def cleanup_old_backups(self, retention_days):
        """Remove backups older than retention period"""
        cutoff_date = datetime.now() - timedelta(days=retention_days)
        
        response = self.s3_client.list_objects_v2(
            Bucket=self.backup_bucket,
            Prefix='database/'
        )
        
        for obj in response.get('Contents', []):
            if obj['LastModified'].replace(tzinfo=None) < cutoff_date:
                self.s3_client.delete_object(
                    Bucket=self.backup_bucket,
                    Key=obj['Key']
                )
    
    def restore_from_backup(self, backup_file):
        """Restore database from encrypted backup"""
        # Download from S3
        obj = self.s3_client.get_object(
            Bucket=self.backup_bucket,
            Key=f'database/{backup_file}'
        )
        
        encrypted_data = obj['Body'].read()
        
        # Decrypt
        encryption_service = EncryptionService()
        decrypted_data = encryption_service.decrypt_data_aes_256(
            encrypted_data,
            os.environ['BACKUP_ENCRYPTION_KEY']
        )
        
        # Write to temp file
        with open(f'/tmp/{backup_file}', 'wb') as f:
            f.write(decrypted_data)
        
        # Restore database
        os.system(f'gunzip < /tmp/{backup_file} | psql -U postgres familiar_db')
        
        # Log restoration
        AuditLog.create(
            action='DATABASE_RESTORED',
            details={'backup_file': backup_file},
            timestamp=datetime.now()
        )

# Schedule backups
backup_service = BackupService()

# Daily full backup at 2 AM
schedule.every().day.at("02:00").do(backup_service.create_database_backup)

# Continuous incremental backups every 4 hours
schedule.every(4).hours.do(backup_service.create_database_backup)
```

---

## 5. Physical Safeguards

### 5.1 Facility Access Controls

**Requirements**:
- Controlled physical access to facilities with ePHI
- Visitor logs and escort procedures
- Video surveillance of sensitive areas
- Secure disposal of physical media

### 5.2 Workstation Security

**Requirements**:
- Screen privacy filters for public areas
- Automatic screen lock after inactivity
- Clean desk policy
- Encrypted hard drives

### 5.3 Device and Media Controls

**Implementation Example**:

```javascript
// Device registration and tracking system
class DeviceManagementService {
  async registerDevice(userId, deviceInfo) {
    const device = await Device.create({
      userId: userId,
      deviceId: deviceInfo.deviceId,
      deviceType: deviceInfo.type, // mobile, laptop, desktop
      osVersion: deviceInfo.osVersion,
      appVersion: deviceInfo.appVersion,
      lastSeen: new Date(),
      isEncrypted: false,
      complianceStatus: 'PENDING'
    });
    
    // Check device compliance
    await this.checkDeviceCompliance(device.id);
    
    return device;
  }
  
  async checkDeviceCompliance(deviceId) {
    const device = await Device.findById(deviceId);
    const checks = {
      encryptionEnabled: false,
      screenLockEnabled: false,
      osUpToDate: false,
      antimalwareInstalled: false
    };
    
    // Verify encryption (implementation depends on platform)
    // This would typically use device management APIs
    
    const isCompliant = Object.values(checks).every(v => v === true);
    
    await Device.update(deviceId, {
      complianceStatus: isCompliant ? 'COMPLIANT' : 'NON_COMPLIANT',
      lastComplianceCheck: new Date()
    });
    
    if (!isCompliant) {
      // Alert IT team and restrict access
      await this.restrictDeviceAccess(deviceId);
    }
    
    return { isCompliant, checks };
  }
  
  async restrictDeviceAccess(deviceId) {
    await Device.update(deviceId, { accessRestricted: true });
    
    // Notify user
    const device = await Device.findById(deviceId);
    await NotificationService.send({
      userId: device.userId,
      type: 'SECURITY_ALERT',
      message: 'Your device does not meet security requirements. Access has been restricted.'
    });
  }
  
  async wipeDevice(deviceId) {
    // Remote wipe capability for lost/stolen devices
    const device = await Device.findById(deviceId);
    
    // Send wipe command to device (MDM integration)
    await MDMService.sendWipeCommand(device.deviceId);
    
    // Log the action
    await AuditLog.create({
      action: 'DEVICE_REMOTE_WIPE',
      deviceId: deviceId,
      timestamp: new Date()
    });
    
    await Device.update(deviceId, {
      status: 'WIPED',
      wipedAt: new Date()
    });
  }
}
```

---

## 6. Data Privacy and Consent Management

### 6.1 Patient Consent

**Requirements**:
- Explicit consent before collecting/processing health data
- Clear explanation of data usage
- Easy consent withdrawal mechanism
- Granular consent options

**Implementation Example**:

```typescript
// Consent management system
interface ConsentRecord {
  userId: string;
  consentType: 'DATA_COLLECTION' | 'DATA_SHARING' | 'RESEARCH' | 'MARKETING';
  granted: boolean;
  timestamp: Date;
  expiresAt?: Date;
  ipAddress: string;
  userAgent: string;
}

class ConsentService {
  async recordConsent(
    userId: string,
    consentType: string,
    granted: boolean
  ): Promise<ConsentRecord> {
    const consent = await Consent.create({
      userId,
      consentType,
      granted,
      timestamp: new Date(),
      expiresAt: this.calculateExpiration(consentType),
      ipAddress: this.getClientIP(),
      userAgent: this.getClientUserAgent()
    });
    
    // Audit trail
    await AuditLog.create({
      userId,
      action: granted ? 'CONSENT_GRANTED' : 'CONSENT_REVOKED',
      resourceType: 'CONSENT',
      resourceId: consent.id,
      timestamp: new Date()
    });
    
    return consent;
  }
  
  async checkConsent(userId: string, consentType: string): Promise<boolean> {
    const consent = await Consent.findOne({
      userId,
      consentType,
      granted: true,
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } }
      ]
    });
    
    return consent !== null;
  }
  
  async revokeConsent(userId: string, consentType: string): Promise<void> {
    await this.recordConsent(userId, consentType, false);
    
    // Trigger data anonymization/deletion if required
    if (consentType === 'DATA_COLLECTION') {
      await this.initiateDataDeletion(userId);
    }
  }
  
  async initiateDataDeletion(userId: string): Promise<void> {
    // GDPR Right to be Forgotten
    await DataDeletionQueue.add({
      userId,
      requestedAt: new Date(),
      status: 'PENDING',
      completionDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    });
  }
  
  async exportUserData(userId: string): Promise<object> {
    // GDPR Right to Data Portability
    const userData = {
      personalInfo: await User.findById(userId),
      medicalRecords: await MedicalRecord.find({ patientId: userId }),
      consents: await Consent.find({ userId }),
      auditLogs: await AuditLog.find({ userId })
    };
    
    // Anonymize sensitive fields
    return this.anonymizeSensitiveData(userData);
  }
}
```

### 6.2 Data Minimization

**Principles**:
- Collect only necessary data
- Limit data retention periods
- Anonymize/pseudonymize when possible
- Secure deletion procedures

```python
# Data anonymization service
import hashlib
from faker import Faker

class DataAnonymizationService:
    def __init__(self):
        self.faker = Faker()
    
    def anonymize_patient_record(self, record):
        """Anonymize patient record for research/analytics"""
        anonymized = {
            # Replace PII with synthetic data
            'patient_id': self.hash_identifier(record['patient_id']),
            'age_group': self.group_age(record['age']),
            'gender': record['gender'],  # Keep for research
            'zip_prefix': record['zip_code'][:3],  # First 3 digits only
            
            # Remove direct identifiers
            # 'name': REMOVED
            # 'ssn': REMOVED
            # 'address': REMOVED
            # 'phone': REMOVED
            # 'email': REMOVED
            
            # Keep clinical data
            'diagnosis_codes': record['diagnosis_codes'],
            'medications': record['medications'],
            'lab_results': record['lab_results'],
            'admission_date': self.truncate_date_to_month(record['admission_date'])
        }
        
        return anonymized
    
    def hash_identifier(self, identifier):
        """Create consistent hash for linking records"""
        return hashlib.sha256(
            (identifier + os.environ['ANONYMIZATION_SALT']).encode()
        ).hexdigest()[:16]
    
    def group_age(self, age):
        """Group ages into ranges"""
        if age < 18:
            return '0-17'
        elif age < 30:
            return '18-29'
        elif age < 50:
            return '30-49'
        elif age < 65:
            return '50-64'
        else:
            return '65+'
    
    def truncate_date_to_month(self, date):
        """Remove day information from date"""
        return date.strftime('%Y-%m-01')
    
    def pseudonymize_for_research(self, records):
        """Create pseudonymized dataset for research"""
        pseudonymized_records = []
        
        for record in records:
            pseudo_record = self.anonymize_patient_record(record)
            pseudonymized_records.append(pseudo_record)
        
        return pseudonymized_records
```

---

## 7. Incident Response and Breach Notification

### 7.1 Incident Detection and Response

**Requirements**:
- 24/7 security monitoring
- Incident response plan
- Breach notification procedures (within 60 days for HIPAA)
- Post-incident analysis

**Implementation Example**:

```javascript
// Incident detection and response system
class SecurityIncidentService {
  async detectAnomalousActivity() {
    const alerts = [];
    
    // Detect multiple failed login attempts
    const failedLogins = await AuditLog.aggregate([
      {
        $match: {
          action: 'LOGIN_FAILED',
          timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: '$userId',
          count: { $sum: 1 }
        }
      },
      {
        $match: { count: { $gte: 5 } }
      }
    ]);
    
    if (failedLogins.length > 0) {
      alerts.push({
        type: 'BRUTE_FORCE_ATTEMPT',
        severity: 'HIGH',
        affectedUsers: failedLogins.map(f => f._id)
      });
    }
    
    // Detect unusual data access patterns
    const unusualAccess = await this.detectUnusualDataAccess();
    if (unusualAccess.length > 0) {
      alerts.push({
        type: 'UNUSUAL_DATA_ACCESS',
        severity: 'CRITICAL',
        details: unusualAccess
      });
    }
    
    // Detect unauthorized API access
    const unauthorizedAccess = await AuditLog.find({
      action: { $regex: /^API_/ },
      statusCode: 403,
      timestamp: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
    });
    
    if (unauthorizedAccess.length > 10) {
      alerts.push({
        type: 'UNAUTHORIZED_API_ACCESS',
        severity: 'MEDIUM',
        count: unauthorizedAccess.length
      });
    }
    
    // Process and escalate alerts
    for (const alert of alerts) {
      await this.handleSecurityAlert(alert);
    }
    
    return alerts;
  }
  
  async detectUnusualDataAccess() {
    // Machine learning-based anomaly detection would go here
    // Simple rule-based example:
    const suspicious = await AuditLog.aggregate([
      {
        $match: {
          action: 'READ_MEDICAL_RECORD',
          timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: '$userId',
          recordsAccessed: { $sum: 1 },
          uniquePatients: { $addToSet: '$resourceId' }
        }
      },
      {
        $match: {
          recordsAccessed: { $gt: 100 } // Unusually high access
        }
      }
    ]);
    
    return suspicious;
  }
  
  async handleSecurityAlert(alert) {
    // Create incident record
    const incident = await SecurityIncident.create({
      type: alert.type,
      severity: alert.severity,
      detectedAt: new Date(),
      status: 'NEW',
      details: alert
    });
    
    // Auto-respond to critical incidents
    if (alert.severity === 'CRITICAL') {
      await this.initiateIncidentResponse(incident.id);
    }
    
    // Notify security team
    await this.notifySecurityTeam(incident);
    
    return incident;
  }
  
  async initiateIncidentResponse(incidentId) {
    const incident = await SecurityIncident.findById(incidentId);
    
    // Automatic containment actions
    switch (incident.type) {
      case 'BRUTE_FORCE_ATTEMPT':
        // Lock affected accounts
        for (const userId of incident.details.affectedUsers) {
          await User.update(userId, { accountLocked: true });
        }
        break;
        
      case 'UNUSUAL_DATA_ACCESS':
        // Suspend suspicious user accounts
        for (const user of incident.details) {
          await User.update(user._id, { accountSuspended: true });
        }
        break;
    }
    
    await SecurityIncident.update(incidentId, {
      status: 'CONTAINED',
      containedAt: new Date()
    });
  }
  
  async notifySecurityTeam(incident) {
    // Multi-channel notifications
    await Promise.all([
      EmailService.send({
        to: 'security@familiar.com',
        subject: `[${incident.severity}] Security Incident: ${incident.type}`,
        body: JSON.stringify(incident, null, 2)
      }),
      SlackService.postMessage({
        channel: '#security-alerts',
        message: `🚨 Security Incident Detected\nType: ${incident.type}\nSeverity: ${incident.severity}\nID: ${incident.id}`
      }),
      // For critical incidents, page on-call engineer
      incident.severity === 'CRITICAL' 
        ? PagerDutyService.createIncident(incident)
        : Promise.resolve()
    ]);
  }
  
  async createBreachNotification(incidentId) {
    const incident = await SecurityIncident.findById(incidentId);
    
    // Determine if breach meets notification threshold
    const affectedRecords = await this.assessBreachImpact(incident);
    
    if (affectedRecords.length > 0) {
      const breach = await DataBreach.create({
        incidentId: incidentId,
        discoveryDate: new Date(),
        affectedRecordsCount: affectedRecords.length,
        affectedIndividuals: affectedRecords.map(r => r.patientId),
        notificationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
        status: 'PENDING_NOTIFICATION'
      });
      
      // If affecting 500+ individuals, notify HHS and media (HIPAA requirement)
      if (affectedRecords.length >= 500) {
        breach.requiresMediaNotification = true;
        breach.requiresHHSNotification = true;
      }
      
      await breach.save();
      
      // Start notification process
      await this.executeBreachNotificationPlan(breach.id);
    }
  }
}
```

### 7.2 Breach Notification Timeline

**HIPAA Requirements**:
- **Individual Notification**: Within 60 days of discovery
- **Media Notification**: If 500+ individuals affected (immediately)
- **HHS Notification**: 
  - Within 60 days if <500 individuals
  - Immediately if 500+ individuals

---

## 8. Business Associate Agreements (BAA)

### 8.1 When BAA is Required

A Business Associate Agreement is required when:
- Third-party vendors access, store, or process ePHI
- Cloud service providers host healthcare applications
- Payment processors handle medical billing
- Analytics services process healthcare data

### 8.2 Key BAA Clauses

**Required Components**:
1. Permitted uses and disclosures of PHI
2. Prohibition on unauthorized use or disclosure
3. Implementation of appropriate safeguards
4. Reporting of security incidents and breaches
5. Subcontractor agreements (BAA flow-down)
6. Right to audit and inspect
7. Return or destruction of PHI upon termination

---

## 9. Testing and Compliance Verification

### 9.1 Security Testing Requirements

**Testing Types**:

1. **Penetration Testing**: Annually minimum
2. **Vulnerability Scanning**: Monthly
3. **Security Audits**: Quarterly
4. **Disaster Recovery Testing**: Semi-annually

**Implementation Example**:

```javascript
// Automated security testing framework
const { ZAP } = require('zaproxy');
const nmap = require('node-nmap');

class SecurityTestingService {
  async runVulnerabilityScans() {
    const results = {
      timestamp: new Date(),
      tests: []
    };
    
    // OWASP ZAP scanning
    const zapScan = await this.runZAPScan();
    results.tests.push(zapScan);
    
    // Network scanning
    const networkScan = await this.runNetworkScan();
    results.tests.push(networkScan);
    
    // Dependency vulnerability check
    const depCheck = await this.runDependencyCheck();
    results.tests.push(depCheck);
    
    // Generate compliance report
    await this.generateComplianceReport(results);
    
    return results;
  }
  
  async runZAPScan() {
    const zap = new ZAP({
      apiKey: process.env.ZAP_API_KEY,
      proxy: 'http://localhost:8080'
    });
    
    await zap.spider.scan('https://familiar.app');
    await zap.ascan.scan('https://familiar.app');
    
    const alerts = await zap.core.alerts();
    
    return {
      type: 'ZAP_SCAN',
      vulnerabilities: alerts.filter(a => a.risk === 'High' || a.risk === 'Medium'),
      passed: alerts.filter(a => a.risk === 'High').length === 0
    };
  }
  
  async runNetworkScan() {
    const scan = new nmap.QuickScan('familiar.app');
    
    return new Promise((resolve) => {
      scan.on('complete', (data) => {
        const openPorts = data[0]?.host[0]?.ports[0]?.port || [];
        const riskyPorts = openPorts.filter(p => 
          ['21', '23', '445', '3389'].includes(p.$.portid)
        );
        
        resolve({
          type: 'NETWORK_SCAN',
          openPorts: openPorts.length,
          riskyPorts: riskyPorts,
          passed: riskyPorts.length === 0
        });
      });
      
      scan.startScan();
    });
  }
  
  async runDependencyCheck() {
    // Use npm audit or snyk
    const { exec } = require('child_process');
    
    return new Promise((resolve) => {
      exec('npm audit --json', (error, stdout) => {
        const audit = JSON.parse(stdout);
        const criticalVulns = audit.metadata.vulnerabilities.critical || 0;
        const highVulns = audit.metadata.vulnerabilities.high || 0;
        
        resolve({
          type: 'DEPENDENCY_CHECK',
          critical: criticalVulns,
          high: highVulns,
          passed: criticalVulns === 0 && highVulns === 0
        });
      });
    });
  }
}
```

### 9.2 Compliance Documentation

**Required Documentation**:

1. **Policies and Procedures**: Written security policies
2. **Risk Assessments**: Annual risk analysis reports
3. **Training Records**: Employee training completion
4. **Audit Logs**: Maintained for 6+ years
5. **Incident Reports**: Documentation of all security incidents
6. **BAAs**: Signed agreements with all business associates
7. **Disaster Recovery Plan**: Tested procedures with test results

---

## 10. Infrastructure and Architecture Recommendations

### 10.1 Cloud Architecture Best Practices

**Recommended Stack**:

```yaml
# Infrastructure as Code (Terraform example)
# HIPAA-compliant AWS infrastructure

provider "aws" {
  region = "us-east-1"
}

# VPC with private subnets
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  
  tags = {
    Name        = "familiar-hipaa-vpc"
    Compliance  = "HIPAA"
  }
}

# Private subnet for database
resource "aws_subnet" "private_db" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
  
  tags = {
    Name = "familiar-private-db-subnet"
  }
}

# RDS with encryption
resource "aws_db_instance" "main" {
  identifier             = "familiar-db"
  engine                = "postgres"
  engine_version        = "14.7"
  instance_class        = "db.t3.medium"
  allocated_storage     = 100
  storage_encrypted     = true
  kms_key_id           = aws_kms_key.rds.arn
  
  db_subnet_group_name = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  
  backup_retention_period = 30
  backup_window          = "03:00-04:00"
  maintenance_window     = "Mon:04:00-Mon:05:00"
  
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  
  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "familiar-db-final-snapshot"
  
  tags = {
    Compliance = "HIPAA"
  }
}

# KMS key for encryption
resource "aws_kms_key" "rds" {
  description             = "KMS key for RDS encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  
  tags = {
    Compliance = "HIPAA"
  }
}

# CloudTrail for audit logging
resource "aws_cloudtrail" "main" {
  name                          = "familiar-audit-trail"
  s3_bucket_name               = aws_s3_bucket.audit_logs.id
  include_global_service_events = true
  is_multi_region_trail        = true
  enable_log_file_validation   = true
  
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    
    data_resource {
      type   = "AWS::S3::Object"
      values = ["arn:aws:s3:::*/"]
    }
  }
}

# WAF for application protection
resource "aws_wafv2_web_acl" "main" {
  name  = "familiar-waf"
  scope = "REGIONAL"
  
  default_action {
    allow {}
  }
  
  # Block common attack patterns
  rule {
    name     = "RateLimitRule"
    priority = 1
    
    action {
      block {}
    }
    
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name               = "RateLimitRule"
      sampled_requests_enabled  = true
    }
  }
  
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name               = "familiar-waf"
    sampled_requests_enabled  = true
  }
}
```

### 10.2 Network Security

**Requirements**:
- Network segmentation (separate production, staging, development)
- Intrusion Detection/Prevention Systems (IDS/IPS)
- DDoS protection
- VPN for remote access
- Network Access Control Lists (NACLs)

---

## 11. Monitoring and Alerting

### 11.1 Security Monitoring Stack

**Recommended Tools**:

```yaml
# Docker Compose for security monitoring stack
version: '3.8'

services:
  # Elasticsearch for log aggregation
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=true
      - xpack.security.enrollment.enabled=true
    volumes:
      - elasticsearch_data:/usr/share/elasticsearch/data
    
  # Kibana for visualization
  kibana:
    image: docker.elastic.co/kibana/kibana:8.11.0
    ports:
      - "5601:5601"
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    depends_on:
      - elasticsearch
  
  # Logstash for log processing
  logstash:
    image: docker.elastic.co/logstash/logstash:8.11.0
    volumes:
      - ./logstash/pipeline:/usr/share/logstash/pipeline
    depends_on:
      - elasticsearch
  
  # Prometheus for metrics
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    ports:
      - "9090:9090"
  
  # Grafana for dashboards
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=secure_password
    volumes:
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus

volumes:
  elasticsearch_data:
  prometheus_data:
  grafana_data:
```

### 11.2 Key Metrics to Monitor

**Security Metrics**:

- Failed login attempts per hour
- Successful authentications by user role
- API request rate and errors
- Database query patterns
- File access patterns
- Data export/download volumes
- Session duration statistics
- Geographic access patterns (detect anomalies)

**System Health Metrics**:
- CPU and memory utilization
- Database connection pool status
- API response times
- Error rates (4xx, 5xx)
- Backup success/failure rates
- SSL certificate expiration dates

---

## 12. Mobile Application Security

### 12.1 Mobile-Specific Requirements

**iOS/Android Security**:

```swift
// iOS: Secure storage using Keychain
import Security

class SecureStorage {
    func saveToKeychain(key: String, value: String) -> Bool {
        let data = value.data(using: .utf8)!
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        
        SecItemDelete(query as CFDictionary) // Remove existing
        let status = SecItemAdd(query as CFDictionary, nil)
        
        return status == errSecSuccess
    }
    
    func retrieveFromKeychain(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true
        ]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        
        return value
    }
}

// Certificate pinning for API calls
class NetworkManager {
    func setupCertificatePinning() {
        let session = URLSession(
            configuration: .default,
            delegate: self,
            delegateQueue: nil
        )
    }
}

extension NetworkManager: URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        
        // Validate certificate
        let policies = [SecPolicyCreateSSL(true, challenge.protectionSpace.host as CFString)]
        SecTrustSetPolicies(serverTrust, policies as CFTypeRef)
        
        // Pin to specific certificate
        if let serverCertificate = SecTrustGetCertificateAtIndex(serverTrust, 0) {
            let serverCertificateData = SecCertificateCopyData(serverCertificate) as Data
            let pinnedCertificateData = // Load your pinned certificate
            
            if serverCertificateData == pinnedCertificateData {
                completionHandler(.useCredential, URLCredential(trust: serverTrust))
                return
            }
        }
        
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
```

```kotlin
// Android: Secure storage using EncryptedSharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SecureStorage(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    
    private val sharedPreferences = EncryptedSharedPreferences.create(
        context,
        "secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
    
    fun saveSecurely(key: String, value: String) {
        sharedPreferences.edit().putString(key, value).apply()
    }
    
    fun retrieveSecurely(key: String): String? {
        return sharedPreferences.getString(key, null)
    }
}

// Biometric authentication
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

class BiometricAuth(private val activity: FragmentActivity) {
    private val executor = ContextCompat.getMainExecutor(activity)
    
    fun authenticate(onSuccess: () -> Unit, onError: () -> Unit) {
        val biometricPrompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    onSuccess()
                }
                
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    onError()
                }
            }
        )
        
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Authenticate to access medical records")
            .setSubtitle("Use your biometric credential")
            .setNegativeButtonText("Cancel")
            .build()
        
        biometricPrompt.authenticate(promptInfo)
    }
}
```

**Mobile Requirements**:
- Secure local storage (Keychain/EncryptedSharedPreferences)
- Certificate pinning
- Biometric authentication support
- Jailbreak/Root detection
- Code obfuscation
- Automatic session timeout
- Secure data wiping on logout

---

## 13. Third-Party Integration Security

### 13.1 API Security

**Implementation Example**:

```javascript
// OAuth 2.0 implementation for third-party access
const oauth2 = require('simple-oauth2');

class OAuthService {
  constructor() {
    this.oauth2 = oauth2.create({
      client: {
        id: process.env.OAUTH_CLIENT_ID,
        secret: process.env.OAUTH_CLIENT_SECRET
      },
      auth: {
        tokenHost: 'https://oauth.familiar.app',
        tokenPath: '/oauth/token',
        authorizePath: '/oauth/authorize'
      }
    });
  }
  
  async generateAuthorizationUrl(userId, scope) {
    return this.oauth2.authorizationCode.authorizeURL({
      redirect_uri: 'https://partner-app.com/callback',
      scope: scope.join(' '),
      state: this.generateState(userId)
    });
  }
  
  async exchangeCodeForToken(code) {
    const result = await this.oauth2.authorizationCode.getToken({
      code: code,
      redirect_uri: 'https://partner-app.com/callback'
    });
    
    const token = this.oauth2.accessToken.create(result);
    
    // Store token with encryption
    await this.storeToken(token);
    
    return token;
  }
  
  async revokeToken(tokenId) {
    const token = await this.retrieveToken(tokenId);
    await token.revoke('access_token');
  }
}

// API rate limiting
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    client: redisClient
  })
});

app.use('/api/', apiLimiter);
```

---

## 14. Compliance Checklist

### 14.1 Pre-Launch Security Checklist

- [ ] **Access Controls**
  - [ ] User authentication implemented (MFA required)
  - [ ] Role-Based Access Control (RBAC) configured
  - [ ] Session timeout configured (15-30 minutes)
  - [ ] Password policy enforced (12+ characters, complexity, history)

- [ ] **Encryption**
  - [ ] TLS 1.2+ for all connections
  - [ ] AES-256 encryption for data at rest
  - [ ] End-to-end encryption for sensitive data
  - [ ] Key rotation policy implemented

- [ ] **Audit Logging**
  - [ ] All access to ePHI logged
  - [ ] Audit logs retained for 6+ years
  - [ ] Audit log integrity protection (immutable storage)
  - [ ] Regular audit log review process

- [ ] **Data Protection**
  - [ ] Data minimization implemented
  - [ ] Data anonymization/pseudonymization capabilities
  - [ ] Secure deletion procedures
  - [ ] Backup and recovery tested

- [ ] **Security Testing**
  - [ ] Penetration testing completed
  - [ ] Vulnerability scanning automated
  - [ ] Code security review completed
  - [ ] Dependency vulnerability checks automated

- [ ] **Policies and Procedures**
  - [ ] Written security policies documented
  - [ ] Incident response plan created and tested
  - [ ] Disaster recovery plan documented and tested
  - [ ] Privacy policy published
  - [ ] Terms of service published

- [ ] **Training**
  - [ ] Security awareness training completed
  - [ ] HIPAA training for relevant staff
  - [ ] Training records maintained

- [ ] **Business Associates**
  - [ ] BAAs signed with all vendors
  - [ ] Vendor security assessments completed
  - [ ] Third-party access reviewed and approved

- [ ] **Infrastructure**
  - [ ] Network segmentation implemented
  - [ ] Firewall rules configured
  - [ ] DDoS protection enabled
  - [ ] Intrusion detection/prevention enabled
  - [ ] Security monitoring and alerting configured

- [ ] **Mobile Security** (if applicable)
  - [ ] Secure local storage implemented
  - [ ] Certificate pinning enabled
  - [ ] Jailbreak/root detection
  - [ ] Code obfuscation applied

---

## 15. Resources and References

### 15.1 Official Documentation

- **HIPAA**: https://www.hhs.gov/hipaa/index.html
- **GDPR**: https://gdpr.eu/
- **HITECH Act**: https://www.hhs.gov/hipaa/for-professionals/special-topics/hitech-act-enforcement-interim-final-rule/index.html
- **NIST Cybersecurity Framework**: https://www.nist.gov/cyberframework

### 15.2 Security Standards

- **OWASP Top 10**: https://owasp.org/www-project-top-ten/
- **ISO 27001**: Information security management
- **SOC 2**: Service organization controls for security
- **HITRUST CSF**: Common Security Framework for healthcare

### 15.3 Implementation Tools

**Security Libraries**:
- **Node.js**: helmet, bcrypt, jsonwebtoken, express-rate-limit, node-2fa
- **Python**: cryptography, django-axes, django-ratelimit, python-jose
- **Database**: pgcrypto (PostgreSQL), TDE (SQL Server), AWS RDS encryption

**Monitoring Tools**:
- **SIEM**: Splunk, ELK Stack, Datadog
- **Vulnerability Scanning**: OWASP ZAP, Nessus, Qualys
- **Penetration Testing**: Burp Suite, Metasploit
- **Container Security**: Snyk, Aqua Security, Twistlock

**Cloud Security**:
- **AWS**: GuardDuty, Security Hub, CloudTrail, Config
- **Azure**: Security Center, Sentinel, Key Vault
- **GCP**: Security Command Center, Cloud Armor, KMS

### 15.4 Certification and Audit

**Recommended Certifications**:
- HITRUST CSF Certification
- SOC 2 Type II
- ISO 27001
- HIPAA attestation from cloud provider

---

## 16. Summary and Next Steps

### 16.1 Priority Implementation Phases

**Phase 1 (Critical - Weeks 1-4)**:
1. Implement TLS/SSL encryption for all connections
2. Set up user authentication with MFA
3. Implement audit logging for all ePHI access
4. Configure database encryption at rest
5. Establish backup procedures

**Phase 2 (High Priority - Weeks 5-8)**:
1. Implement RBAC and access controls
2. Set up security monitoring and alerting
3. Conduct initial risk assessment
4. Create incident response plan
5. Begin security awareness training

**Phase 3 (Medium Priority - Weeks 9-12)**:
1. Implement data anonymization/pseudonymization
2. Set up automated vulnerability scanning
3. Conduct penetration testing
4. Review and sign BAAs with vendors
5. Document all policies and procedures

**Phase 4 (Ongoing)**:
1. Regular security audits (quarterly)
2. Annual penetration testing
3. Continuous monitoring and alerting
4. Regular training updates
5. Policy review and updates

### 16.2 Key Success Factors

1. **Executive Buy-In**: Security must be a top priority
2. **Security-First Culture**: Train all employees on security best practices
3. **Regular Testing**: Continuously test and validate security measures
4. **Stay Updated**: Keep informed about new threats and compliance requirements
5. **Third-Party Verification**: Engage external auditors for objective assessment

---

## Document Version

- **Version**: 1.0
- **Last Updated**: May 8, 2026
- **Author**: Security Compliance Team
- **Review Schedule**: Quarterly

---

## Appendix A: Glossary

- **ePHI**: Electronic Protected Health Information
- **PHI**: Protected Health Information
- **BAA**: Business Associate Agreement
- **MFA**: Multi-Factor Authentication
- **RBAC**: Role-Based Access Control
- **TLS**: Transport Layer Security
- **AES**: Advanced Encryption Standard
- **KMS**: Key Management Service
- **HSM**: Hardware Security Module
- **IDS/IPS**: Intrusion Detection/Prevention System
- **SIEM**: Security Information and Event Management
- **DDoS**: Distributed Denial of Service

## Appendix B: Sample Incident Response Plan Template

```markdown
# Incident Response Plan

## 1. Preparation
- Security team contact list
- Escalation procedures
- Communication templates
- Forensic tools inventory

## 2. Detection and Analysis
- How to identify security incidents
- Severity classification criteria
- Initial triage procedures

## 3. Containment
- Immediate containment actions
- Short-term containment strategy
- Long-term containment strategy

## 4. Eradication
- Remove threat from systems
- Identify and patch vulnerabilities
- Strengthen security controls

## 5. Recovery
- Restore systems from clean backups
- Verify system integrity
- Monitor for recurring issues

## 6. Post-Incident Activity
- Incident documentation
- Lessons learned meeting
- Policy and procedure updates
- Breach notification if required
```

---

**END OF DOCUMENT**

For questions or clarifications regarding these guidelines, please contact:
- **Security Team**: security@familiar.com
- **Compliance Officer**: compliance@familiar.com
- **Emergency Hotline**: Available 24/7 for critical security incidents
