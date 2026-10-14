// Real images of any size for the thumbnail tests, made in the test rather
// than kept as fixture files. PNGs come from the dev seed's encoder.

export { sunsetPng as makePng } from "../../../scripts/seed"
export { makeGif } from "./gif"

/** The same image in another format, converted by the Images binding. */
export async function convert(images: ImagesBinding, png: Uint8Array<ArrayBuffer>, format: "image/jpeg") {
  const out = await images.input(new Blob([png]).stream()).output({ format })
  return new Uint8Array(await out.response().arrayBuffer())
}
