# Quick Railway Deploy Script
Write-Host "🚀 Railway Quick Deploy" -ForegroundColor Cyan
Write-Host ""

# Check if Railway CLI is available
try {
    $version = railway --version 2>&1
    Write-Host "✅ Railway CLI found: $version" -ForegroundColor Green
} catch {
    Write-Host "❌ Railway CLI not found. Please install it first." -ForegroundColor Red
    exit 1
}

# Check authentication
Write-Host "Checking authentication..." -ForegroundColor Yellow
$whoami = railway whoami 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ $whoami" -ForegroundColor Green
} else {
    Write-Host "❌ Not authenticated. Please run: railway login" -ForegroundColor Red
    exit 1
}

# Check if project is linked
Write-Host "Checking project link..." -ForegroundColor Yellow
railway status 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Project is linked" -ForegroundColor Green
} else {
    Write-Host "⚠️  Project not linked. You'll need to run: railway link" -ForegroundColor Yellow
    Write-Host "   Then select 'SMS Production' from the list" -ForegroundColor Yellow
    Write-Host ""
    $link = Read-Host "Would you like to link now? (y/n)"
    if ($link -eq "y" -or $link -eq "Y") {
        railway link
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Link failed" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "Please link the project first, then run this script again." -ForegroundColor Yellow
        exit 1
    }
}

# Deploy
Write-Host ""
Write-Host "🚀 Deploying to Railway..." -ForegroundColor Cyan
railway up

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ Deployment initiated!" -ForegroundColor Green
    Write-Host "Check your Railway dashboard for deployment status." -ForegroundColor Yellow
} else {
    Write-Host ""
    Write-Host "❌ Deployment failed. Check the error above." -ForegroundColor Red
    exit 1
}





