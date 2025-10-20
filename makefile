package:
	@docker build -t bittensor-burnercode .

dev-env:
	@docker run --name burnercode --rm \
		-v .env:/usr/src/app/.env \
		bittensor-burnercode
