# Slack Notifications Setup

This guide explains how to set up Slack notifications for the server-decorator library releases.

## 🔧 Prerequisites

1. **Slack Workspace**: Admin access to your Slack workspace
2. **GitHub Repository**: Admin access to set repository secrets

## 📋 Setup Steps

### 1. Create Slack App and Webhook

1. **Go to Slack API**: Visit [api.slack.com/apps](https://api.slack.com/apps)

2. **Create New App**:
   - Click "Create New App"
   - Choose "From scratch"
   - App Name: `GitHub Releases - server-decorator`
   - Workspace: Select your workspace

3. **Enable Incoming Webhooks**:
   - Go to "Incoming Webhooks" in the sidebar
   - Toggle "Activate Incoming Webhooks" to **On**
   - Click "Add New Webhook to Workspace"

4. **Choose Channel**:
   - Select the channel where you want notifications (e.g., `#releases`, `#dev-notifications`)
   - Click "Allow"

5. **Copy Webhook URL**:
   - Copy the webhook URL (starts with `https://hooks.slack.com/services/...`)
   - ⚠️ **Keep this secure** - it provides access to your Slack channel

### 2. Add GitHub Repository Secret

1. **Go to Repository Settings**:
   - Navigate to your GitHub repository
   - Click "Settings" tab
   - Click "Secrets and variables" → "Actions"

2. **Add Secret**:
   - Click "New repository secret"
   - Name: `SLACK_WEBHOOK_URL`
   - Value: Paste the webhook URL from step 1.5
   - Click "Add secret"

### 3. Test the Setup

1. **Trigger a Release**:
   - Update version in `package.json`
   - Commit and push to `main` branch
   - Wait for GitHub Actions to complete

2. **Check Notifications**:
   - ✅ **Success**: Should see a green notification with release details
   - ❌ **Failure**: Should see a red notification with error details

## 📱 Notification Examples

### ✅ Success Notification
```
🚀 New Release Published!

📦 Package: server-decorator
🏷️ Version: v1.2.3
🔗 Repository: username/server-decorator
📦 NPM Package: View on NPM
💾 Installation: pnpm add server-decorator@1.2.3
📖 Release Notes: View Release Notes
```

### ❌ Failure Notification
```
❌ Release Failed!

📦 Package: server-decorator
🏷️ Version: v1.2.3
❌ Failed Step: Build/Test
🔗 Repository: username/server-decorator
🔍 Workflow Run: View Logs
```

## 🎛️ Customization Options

### Change Notification Channel
1. Create a new webhook for a different channel
2. Update the `SLACK_WEBHOOK_URL` secret

### Customize Message Format
Edit `.github/workflows/publish.yml`:
- Modify the `custom_payload` section
- Add/remove fields as needed
- Change colors: `good` (green), `warning` (yellow), `danger` (red)

### Add Mentions
Add to the Slack payload:
```json
{
  "text": "🚀 New Release Published! <@channel>",
  // ... rest of payload
}
```

## 🔒 Security Notes

- **Never commit webhook URLs** to your repository
- **Use repository secrets** for sensitive data
- **Rotate webhooks** if compromised
- **Limit webhook permissions** to specific channels

## 🛠️ Troubleshooting

### Notifications Not Appearing
1. Check GitHub Actions logs for errors
2. Verify `SLACK_WEBHOOK_URL` secret is set correctly
3. Ensure Slack app has permissions to post to the channel
4. Test webhook URL manually using curl:
   ```bash
   curl -X POST -H 'Content-type: application/json' \
     --data '{"text":"Test message"}' \
     YOUR_WEBHOOK_URL
   ```

### Wrong Channel
1. Create new webhook for correct channel
2. Update repository secret with new URL

### Missing Information
1. Check that all workflow outputs are correctly set
2. Verify job dependencies in the workflow file

## 📚 Additional Resources

- [Slack Webhook Documentation](https://api.slack.com/messaging/webhooks)
- [GitHub Actions Slack Integration](https://github.com/8398a7/action-slack)
- [Slack Block Kit Builder](https://app.slack.com/block-kit-builder) - for custom message layouts

## 🎯 Best Practices

1. **Use dedicated channels** for automated notifications
2. **Include relevant team members** in the channel
3. **Test notifications** in a development environment first
4. **Monitor notification volume** to avoid spam
5. **Document the setup** for team members

---

Happy releasing! 🚀 