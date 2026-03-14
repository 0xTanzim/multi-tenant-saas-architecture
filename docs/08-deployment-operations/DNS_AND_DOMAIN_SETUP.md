# DNS and Domain Setup Guide

Step-by-step guide for configuring DNS records and pointing your domain to your application server.

## Table of Contents

1. [DNS Architecture Overview](#1-dns-architecture-overview)
2. [DNS Configuration Steps](#2-dns-configuration-steps)
3. [DNS Verification](#3-dns-verification)
4. [Nginx Server Configuration](#4-nginx-server-configuration)
5. [Environment Variable Updates](#5-environment-variable-updates)
6. [SSL/TLS Setup](#6-ssltls-setup)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. DNS Architecture Overview

### How Traffic Flows

```
┌─────────────────────────────────────────────────────────────────┐
│ User types: https://yourdomain.com                              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                        DNS Lookup
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                             │
   A Record                                    AAAA Record
   (IPv4)                                      (IPv6)
        │                                             │
        ▼                                             ▼
    1.2.3.4                                  2001:db8::1
   (Your EC2 IP)                            (Optional IPv6)
        │                                             │
        └──────────────────────┬──────────────────────┘
                               │
                    EC2 Server :80/:443
                               │
                      ┌────────▼────────┐
                      │ Nginx Reverse   │
                      │ Proxy           │
                      └────────┬────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
         /api/*  │                    /* (all else)
              ┌──▼────┐            ┌────────▼───┐
              │ API   │            │  Web       │
              │ :8444 │            │  :3001     │
              └───────┘            └────────────┘
```

### Key Concepts

- **DNS Registry** — Where domain is registered (one.com, GoDaddy, Route 53, etc.)
- **DNS Records** — Entries that map domain names to IP addresses
- **A Record** — Maps domain to IPv4 address
- **AAAA Record** — Maps domain to IPv6 address (optional)
- **CNAME** — Creates alias for another domain (should NOT be used for root domain)
- **MX Records** — Routes email (leave unchanged if using email)
- **TTL** — Time To Live (how long DNS result is cached)

---

## 2. DNS Configuration Steps

### Step 1: Get Your Server IP Address

First, determine your server's public IP:

```bash
# On your server
curl -s https://checkip.amazonaws.com
# Output: 1.2.3.4

# Or from your cloud provider console (AWS, DigitalOcean, Linode, etc.)
# EC2 Instance → Details → Public IPv4 address
```

**For Elastic/Static IPs:** Ensure you've allocated and associated a static IP to prevent changes.

### Step 2: Access Your DNS Provider's Control Panel

Different providers have different interfaces. Here are common ones:

**AWS Route 53:**

```
AWS Console → Route 53 → Hosted Zones → your-domain.com → Records
```

**one.com:**

```
one.com Control Panel → Domains → your-domain.com → DNS Settings
```

**GoDaddy:**

```
GoDaddy Control Panel → Domains → Manage DNS
```

**Google Domains:**

```
Google Domains → your-domain.com → DNS → Custom records
```

### Step 3: Create or Update A Record

For the root domain (`yourdomain.com`):

| Field          | Value                          |
| -------------- | ------------------------------ |
| **Name/Host**  | `@` or blank (represents root) |
| **Type**       | `A`                            |
| **Value/Data** | `1.2.3.4` (your server IP)     |
| **TTL**        | `3600` (1 hour) or default     |

For the www subdomain (`www.yourdomain.com`):

| Field          | Value                      |
| -------------- | -------------------------- |
| **Name/Host**  | `www`                      |
| **Type**       | `A`                        |
| **Value/Data** | `1.2.3.4` (same as root)   |
| **TTL**        | `3600` (1 hour) or default |

### Step 4: Delete Conflicting Records

If the following exist, **delete them**:

- Old A records pointing to different IPs
- CNAME records for `www` (DNS doesn't allow CNAME for root, and A is better)
- Any forwarding entries that override DNS

⚠️ **Do NOT delete:**

- MX records (email routing) — leave alone
- SPF, DKIM, DMARC records (email authentication)

### Step 5: Wait for Propagation

DNS changes take time to propagate globally:

- **Typical:** 15-30 minutes
- **Maximum:** 48 hours (rarely)

You can track propagation:

- https://dnschecker.org/#A/yourdomain.com
- https://www.whatsmydns.net/#A/yourdomain.com

---

## 3. DNS Verification

### Verify A Record is Set

```bash
# Using dig (Linux/Mac)
dig yourdomain.com +short
# Expected output: 1.2.3.4

dig www.yourdomain.com +short
# Expected output: 1.2.3.4

# Using nslookup (all platforms)
nslookup yourdomain.com
# Should show: Address: 1.2.3.4

nslookup www.yourdomain.com
# Should show: Address: 1.2.3.4
```

### Verify Connectivity

```bash
# Test HTTP connectivity
curl -I http://yourdomain.com
# Expected: HTTP/1.1 200 or 301/302 (redirect)

curl -I http://www.yourdomain.com
# Expected: HTTP/1.1 200 or similar

# Test API endpoint
curl http://yourdomain.com/api/health
# Expected: Valid JSON response
```

### Verify in Multiple Locations

Use online tools to verify DNS resolves correctly worldwide:

- https://mxtoolbox.com/ (select "DNS Lookup")
- https://centralops.net/co/ (choose "DNS Lookup")

---

## 4. Nginx Server Configuration

### Update Nginx Configuration

Update `nginx/default.conf` to specify your domain:

```nginx
server {
    listen 80;
    listen [::]:80;          # IPv6 support
    server_name yourdomain.com www.yourdomain.com;

    # Redirect HTTP to HTTPS (if using SSL)
    # Uncomment after SSL is configured:
    # return 301 https://$server_name$request_uri;

    # ... rest of server configuration ...
}

# After SSL setup, add:
# server {
#     listen 443 ssl http2;
#     listen [::]:443 ssl http2;
#     server_name yourdomain.com www.yourdomain.com;
#     # SSL configuration ...
# }
```

### Reload Nginx

```bash
# Verify configuration syntax
docker compose exec nginx nginx -t

# Reload configuration
docker compose exec nginx nginx -s reload

# Or restart (brief downtime)
docker compose restart nginx
```

---

## 5. Environment Variable Updates

### Update Server .env File

SSH into your server and update `.env`:

```bash
ssh -i ~/path/to/key.pem user@your-server-ip
cd /path/to/app
nano .env
```

**Update these variables:**

```env
# Old values
FRONTEND_URL=http://1.2.3.4
NEXT_PUBLIC_API_URL=http://1.2.3.4/api
CORS_ORIGINS=http://1.2.3.4

# New values
FRONTEND_URL=https://yourdomain.com
NEXT_PUBLIC_API_URL=https://yourdomain.com/api
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

**Do NOT change these:**

- `BACKEND_URL=http://api:8444` (internal Docker network)
- `DATABASE_*` variables (external RDS)
- `REDIS_*` variables (internal Docker network)

### Rebuild and Restart Services

```bash
# NEXT_PUBLIC_API_URL is baked at build time, so rebuild is required
docker compose build web

# Restart services
docker compose up -d nginx web

# Wait for services to stabilize
sleep 20

# Verify
curl https://yourdomain.com/api/health
```

---

## 6. SSL/TLS Setup

### Option A: Let's Encrypt (Free)

Recommended for most applications.

```bash
# Install certbot
sudo apt install -y certbot

# Stop Nginx temporarily
docker compose stop nginx

# Request certificate
sudo certbot certonly --standalone \
  -d yourdomain.com \
  -d www.yourdomain.com \
  --email admin@yourdomain.com \
  --agree-tos \
  --non-interactive

# Certificates created at:
# /etc/letsencrypt/live/yourdomain.com/
#   ├── fullchain.pem  (certificate)
#   └── privkey.pem    (private key)

# Copy to Nginx directory
sudo mkdir -p /path/to/app/nginx/certs
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem /path/to/app/nginx/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem /path/to/app/nginx/certs/
sudo chown app_user:app_user /path/to/app/nginx/certs/*
sudo chmod 600 /path/to/app/nginx/certs/privkey.pem
```

### Option B: AWS Certificate Manager (if using AWS services)

```bash
# Request certificate via AWS Console
AWS Console → Certificate Manager → Request Certificate
  ├── Domain names: yourdomain.com, www.yourdomain.com
  ├── Validation: DNS
  ├── Follow DNS validation steps
  └── Wait for ISSUED status

# Then configure AWS Application Load Balancer to use the certificate
```

### Update Nginx Configuration for SSL

Edit `nginx/default.conf`:

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.com www.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # ... location blocks (same as HTTP config) ...
}
```

### Update docker-compose.yml

Uncomment HTTPS port and mount cert volume:

```yaml
services:
  nginx:
    ports:
      - '80:80'
      - '443:443' # Uncomment HTTPS
    volumes:
      - ./nginx/certs:/etc/nginx/certs:ro # Mount certificates
```

### Auto-Renewal with Certbot

```bash
# Test renewal
sudo certbot renew --dry-run

# Add auto-renewal to crontab
sudo crontab -e

# Add this line (runs twice daily):
0 */12 * * * certbot renew --quiet --post-hook "docker compose -f /path/to/app/docker-compose.prod.yml restart nginx"
```

---

## 7. Troubleshooting

### Issue: DNS not resolving

**Diagnosis:**

```bash
dig yourdomain.com
# No output or NXDOMAIN error
```

**Fix:**

1. Wait for propagation (can take up to 48 hours)
2. Verify A record was created correctly in DNS provider
3. Check for typos in domain name
4. Try from different network (different ISP DNS cache)

### Issue: Connection refused after DNS points

**Diagnosis:**

```bash
curl yourdomain.com
# Connection refused or timeout
```

**Fix:**

1. Verify server IP is correct: `curl -I http://1.2.3.4`
2. Check security group allows port 80/443
3. Verify Nginx is running: `docker compose ps`
4. Check Nginx logs: `docker compose logs nginx`

### Issue: SSL certificate errors

**Diagnosis:**

```bash
curl https://yourdomain.com
# certificate problem or SSL_ERROR
```

**Fix:**

1. Verify certificate path in nginx.conf is correct
2. Check certificate hasn't expired: `openssl x509 -in certs/fullchain.pem -noout -dates`
3. For Let's Encrypt, verify renewal is working
4. Test with `curl -k` to bypass SSL validation (debugging only)

### Issue: Nginx won't start after SSL setup

**Diagnosis:**

```bash
docker compose logs nginx
# SSL_ERROR or permission denied
```

**Fix:**

1. Verify cert files exist: `ls -la nginx/certs/`
2. Check permissions: `sudo chmod 644 nginx/certs/fullchain.pem` and `sudo chmod 600 nginx/certs/privkey.pem`
3. Check nginx.conf syntax: `docker compose exec nginx nginx -t`
4. Verify paths in config are correct

---

## Quick Checklist

- [ ] Server IP address obtained and assigned
- [ ] A record created: `@` → server IP
- [ ] A record created: `www` → server IP
- [ ] TTL set (3600 or default)
- [ ] Old conflicting records deleted
- [ ] DNS propagation verified (dig, nslookup)
- [ ] Nginx config updated with domain name
- [ ] Environment variables updated (.env)
- [ ] Web image rebuilt (NEXT_PUBLIC_API_URL changes)
- [ ] HTTP connectivity verified
- [ ] SSL certificate obtained (Let's Encrypt or other)
- [ ] Nginx SSL config updated
- [ ] HTTPS connectivity verified
- [ ] HTTP redirects to HTTPS

---

**Last Updated:** May 2026
**Status:** Production Ready
