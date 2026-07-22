FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c

ARG FIXTURE
COPY matrix.json /sandcastle-fixtures/matrix.json
RUN test -n "$FIXTURE" \
    && grep -F "\"$FIXTURE\"" /sandcastle-fixtures/matrix.json >/dev/null

USER 65532:65532
CMD ["/bin/true"]
