import { CardHead } from "../components/Cards.tsx";
import { ABOUT_CHAIN, ABOUT_NOT_SHOWN, ABOUT_READER, ABOUT_SHOWN, FOOTER_LINE } from "../copy.ts";

/** What this explorer shows: the chain in a sentence, what is shown and what is not, and where the numbers come from. The pages keep to a title, a number and a short line; the rest is here. */
export function About() {
  return (
    <>
      <section className="card" aria-labelledby="about-h">
        <CardHead as="h1" title={<span id="about-h">What this explorer shows</span>} />
        <p>{ABOUT_CHAIN}</p>
        <h2 className="about-h">Shown</h2>
        <p>{ABOUT_SHOWN}</p>
        <h2 className="about-h">Not shown</h2>
        <p>{ABOUT_NOT_SHOWN}</p>
        <h2 className="about-h">Where the numbers come from</h2>
        <p>{ABOUT_READER} {FOOTER_LINE}</p>
      </section>
    </>
  );
}
