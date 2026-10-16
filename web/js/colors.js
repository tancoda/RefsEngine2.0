// colors.js -- the colours of the crease pattern drawing. Plain hex colours: change them here and reload.
// (The colours of the page itself and of the reference diagrams are at the top of index.html, inside <style>.)
export const COLORS = {
  // the lines
  mountain: "#ff0000",
  valley: "#0000ff",
  edge: "#000000",              // the border of the paper
  aux: "#00fff2",
  paper: "#f2f2f2",

  // the vertices
  vertexAssigned: "#000000",    // a coordinate that matched an exact value
  vertexProblem: "#cf0000",     // no exact value
  problemGlow: "#ff0000",       // the soft halo under a vertex with no exact value, and under a crease that is almost on the grid
  refDot: "#000000",            // a vertex the reference database knows
  refPicked: "#ffe600",         // the one whose sequence is showing
  refPickedOutline: "#000000",
  refPickedGlow: "#ff1fd0",
};
export const LINE_WIDTH = 2;    // screen pixels