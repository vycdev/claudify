$ErrorActionPreference = "Stop"

# Get the directory of the script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $scriptDir ".env"
if (-not (Test-Path $envPath)) {
    $envPath = Join-Path $scriptDir "default.env"
}
$repoRoot = Split-Path -Parent $scriptDir

# Load .env file
$envFile = Get-Content $envPath | ForEach-Object {
    $name, $value = $_ -split '=', 2
    Set-Variable -Name $name -Value $value
}

# Define variables from .env
$registry = $REGISTRY
$username = $USERNAME
$password = $PASSWORD
$imageName = $IMAGE_NAME
$tag = $IMAGE_TAG

# Echo non-secret variables
echo "Registry: $($registry)"
echo "Username: $($username)"
echo "Image Name: $($imageName)"
echo "Tag: $($tag)"

# Login only when credentials are configured. Pass the password over stdin so
# it is not exposed in the process list.
if ($username -or $password) {
    if (-not $username -or -not $password) {
        throw "USERNAME and PASSWORD must either both be set or both be empty."
    }
    $password | docker login $registry --username $username --password-stdin
}

$image = "$($registry)/$($imageName):$($tag)"
docker build --pull --tag $image $repoRoot
docker push $image
