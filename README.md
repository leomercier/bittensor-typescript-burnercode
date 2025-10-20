# Bittensor TypeScript Weight Setting Tool

A TypeScript-based tool for setting weights on Bittensor subnets with advanced Drand timelock encryption support.

## Features

- **Drand Timelock Encryption**: Implements commit-reveal schemes using Drand's distributed randomness beacon
- **Multiple Commit Methods**: Supports both CRv3 (`commitCrv3Weights`) and CRv4 (`commitTimelockedWeights`) extrinsics
- **Automatic Mode Detection**: Intelligently switches between standard weight setting and commit-reveal based on subnet configuration
- **Rate Limiting**: Respects subnet weight setting rate limits to prevent transaction failures
- **Continuous Operation**: Runs in a continuous loop with proper timing and error handling
- **Comprehensive Logging**: Detailed debug logging with structured JSON output
- **Docker Support**: Includes containerization for easy deployment

## Installation

```bash
# Clone and install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Create a `.env` file with the following required variables:

```env
# Bittensor Network Configuration
BITTENSOR_NETWORK_URL=wss://entrypoint-finney.opentensor.ai:443
BITTENSOR_SUBNET_ID=111
VALIDATOR_SS58_ADDRESS=5GrwvaEF5zaeofjbwr9384fhleCtERHpNehXCPcNoHGKutQY
VALIDATOR_SECRET_PHRASE=your_validator_mnemonic_here

# Drand Configuration (for timelock encryption)
DRAND_API_BASE_URL=https://api.drand.sh
DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
DRAND_PUBLIC_KEY=83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4c4de8833e
```

### Environment Variables

| Variable                  | Description                              | Required |
| ------------------------- | ---------------------------------------- | -------- |
| `BITTENSOR_NETWORK_URL`   | WebSocket endpoint for Bittensor network | Yes      |
| `BITTENSOR_SUBNET_ID`     | Target subnet ID                         | Yes      |
| `VALIDATOR_SS58_ADDRESS`  | Your validator's SS58 address            | Yes      |
| `VALIDATOR_SECRET_PHRASE` | Your validator's mnemonic phrase         | Yes      |
| `DRAND_API_BASE_URL`      | Drand API base URL                       | Yes      |
| `DRAND_CHAIN_HASH`        | Drand chain hash for verification        | Yes      |
| `DRAND_PUBLIC_KEY`        | Drand public key for verification        | Yes      |

## Usage

### Development

```bash
# Run in development mode
npm start
```

### Docker Deployment

```bash
# Build the Docker image
make package

# Run with environment file
make dev-env
```

### Systemd Service

The project includes systemd service configuration for production deployment:

```bash
# Copy service file
sudo cp notes.txt /etc/systemd/system/burnercode.service

# Enable and start service
sudo systemctl enable burnercode
sudo systemctl start burnercode
```

## How It Works

### Weight Setting Modes

The tool automatically detects the subnet's configuration and chooses the appropriate method:

1. **Standard Mode**: Direct weight setting via `setWeights` extrinsic
2. **Commit-Reveal Mode**: Uses Drand timelock encryption for privacy-preserving weight commits

### Commit-Reveal Process

1. **Weight Preparation**: Normalizes and prepares weight data
2. **Timelock Encryption**: Encrypts weight data using Drand's future randomness
3. **Commit Transaction**: Submits encrypted commitment to the blockchain
4. **Automatic Reveal**: Blockchain automatically decrypts and applies weights when the Drand round is reached

### Rate Limiting

The tool respects subnet-specific rate limits:

- Queries `weightsSetRateLimit` from the blockchain
- Tracks last commit block numbers
- Automatically waits for the required cooldown period

## API Reference

### SubnetWeights Class

The main class providing weight setting functionality:

```typescript
const config: SubnetWeightsConfig = {
    subnetConnection: {
        networkUrl: 'wss://entrypoint-finney.opentensor.ai:443',
        subnetId: 121,
        ss58Address: '5GrwvaEF...',
        secretPhrase: 'first second ...'
    },
    drand: {
        apiBaseUrl: 'https://api.drand.sh',
        chainHash: '52db9ba70e0cc0f6eaf...',
        publicKey: '83cf0f2896adee7eb8b5f...'
    }
};

const subnetWeights = new SubnetWeights(config);

// Set weights once
await subnetWeights.setWeights([0, 1, 2], [0.5, 0.3, 0.2]);

// Continuous weight setting
await subnetWeights.continuousWeightSetting(async () => {
    return { uids: [0], weights: [1.0] };
});
```

### Key Methods

- `setWeights(uids: number[], weights: number[])`: Set weights for specified UIDs
- `continuousWeightSetting(callback)`: Run continuous weight setting loop
- `disconnect()`: Clean up API connections

## Logging

The tool provides comprehensive logging with different levels:

```bash
# Debug output shows:
Current State:
  - Current Block: 3141592
  - Last Commit Block: 3141492
  - Blocks Since Last Commit: 100

Subnet Configuration:
  - Tempo: 360 blocks (~72 min)
  - Weights Rate Limit: 100 blocks (~20 min)
  - Commit-Reveal: Enabled

Weight commit successful!
   Transaction: 0x1234abcd...
   Next commit available after block: 3141692
```

## Error Handling

Common errors and solutions:

- **Rate Limiting**: Tool automatically waits for the required cooldown period
- **Network Issues**: Implements retry logic with exponential backoff
- **Invalid Configuration**: Validates all required parameters at startup
- **Commit-Reveal Errors**: Provides detailed debugging information for troubleshooting

## Security Considerations

- **Private Keys**: Never commit mnemonics to version control
- **Environment Variables**: Use secure methods to provide sensitive configuration
- **Network Security**: Ensure secure connections to Bittensor network endpoints
- **Docker Security**: Run containers with appropriate security contexts

## Development

### Building

```bash
# Compile TypeScript
npm run build

# Run compiled JavaScript
node dist/index.js
```

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:

- Check the logs for detailed error information
- Ensure all environment variables are correctly set
- Verify network connectivity to Bittensor and Drand endpoints
- Review subnet-specific configuration requirements
