#!/bin/bash

# Exit on error
set -e

# Check if version is provided
if [ -z "$1" ]; then
  echo "Error: Version number is required"
  echo "Usage: ./scripts/publish.sh <version>"
  echo "Example: ./scripts/publish.sh 0.0.6"
  exit 1
fi

NEW_VERSION=$1

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print step
print_step() {
  echo -e "\n${YELLOW}Step: $1${NC}"
}

# Update version in package.json
print_step "Updating version to $NEW_VERSION"
cd packages/opdep
npm version $NEW_VERSION --no-git-tag-version
cd ../..

# Build the project
print_step "Building the project"
pnpm nx build opdep

# Copy build files
print_step "Copying build files"
cd packages/opdep
rm -rf dist
mkdir -p dist
cp -r ../../dist/packages/opdep/* dist/

# Commit changes
print_step "Committing changes"
cd ../..
git add .
git commit -m "chore: update version to $NEW_VERSION"
git push

# Publish to npm
print_step "Publishing to npm"
cd packages/opdep
pnpm publish --access public

echo -e "\n${GREEN}Successfully published version $NEW_VERSION${NC}"
echo -e "${GREEN}You can now install it with: pnpm add -D @otter.moon/nx-opdep@$NEW_VERSION${NC}"
