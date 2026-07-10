// Load the caption font families inside the Remotion composition. The SPA gets
// these from a <link> in index.html, but the render's headless browser never
// sees that page, so burned-in caption text silently fell back to a serif.
// Weights/subsets are restricted to what captions actually use — loading every
// face fires hundreds of font requests per render tab and can crash the
// compositor.
import { loadFont as loadBebasNeue } from '@remotion/google-fonts/BebasNeue';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat';
import { loadFont as loadOswald } from '@remotion/google-fonts/Oswald';
import { loadFont as loadPoppins } from '@remotion/google-fonts/Poppins';
import { loadFont as loadRoboto } from '@remotion/google-fonts/Roboto';

export function loadCaptionFonts() {
  loadBebasNeue('normal', { weights: ['400'], subsets: ['latin'] });
  loadInter('normal', { weights: ['400', '700', '900'], subsets: ['latin'] });
  loadMontserrat('normal', { weights: ['400', '700', '900'], subsets: ['latin'] });
  loadOswald('normal', { weights: ['400', '700'], subsets: ['latin'] });
  loadPoppins('normal', { weights: ['400', '700', '900'], subsets: ['latin'] });
  loadRoboto('normal', { weights: ['400', '700', '900'], subsets: ['latin'] });
}
