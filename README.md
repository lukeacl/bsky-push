# bsky-push

## Introduction

bsky-push is a basic script that monitors a Bluesky Jetstream and sends you push notifications via Pushover when someone on a Bluesky List you specify posts or replies to someone you follow.

## Running

Copy .env.example to .env and configure it with your DID, the AT-URI of your list, and your Pushover credentials.

### Locally

You can execute `npm install` followed by `node app` to run the script locally in your terminal.

### Docker

You can use one of the convenience scripts below to run the script in your Docker environment.

- `docker-run.sh` - Runs in Docker interactively
- `docker-deploy.sh` - Deploys and runs in Docker as a daemon
- `docker-stop.sh` - Stops a previously deployed daemon

## Support

Support is limited. If you know your way around a terminal, npm and node, and Docker, you'll probably be ok! If you get too stuck you'll find me on Bluesky, [@lukeacl.com](https://bsky.app/profile/lukeacl.com).

## Contributing

This is a personal project published for others to use if they want. If you're using it and spot a problem or can make an improvement submit a pull request. I'm all ears and happy to take a look!