@web/ is deprecated. Currently trying to re-develop in @monorepo/

# The goal of re-developing

- Improve reproducibilty and testing by separating interfaces and implementations, using Effect v4
- Take lessons learned through the trial & errors from the previous @web/ development, and make fitter logic
- @web/ uses rotating-index with texture 2d array, but this decision was made based on the misunderstanding that mpdecimate filter always compare Nth frame with the (N-1)th frame. In @monorepo/ it will ditch the texture 2d array, and will have just two textures for current, and reference frame.